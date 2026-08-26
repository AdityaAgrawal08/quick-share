import mongoose, { model, Schema } from 'mongoose'
import logger from '../../logger'
import { providerHealth, listRegisteredGenerations, usableProviderCount } from './orchestrator'

// ── Health Monitor (adaptive services ⑤) ────────────────────────────────────
// Periodic ZERO-QUOTA supervision of embedding providers:
//   • reads live breaker states + registered generations
//   • persists a ProviderState snapshot to Mongo so cooldowns/health survive
//     Render restarts (in-memory breakers alone forget everything on redeploy)
//   • exposes the snapshot for /health and the degradation reporter
//
// It never sends test embeddings — real production requests remain the only
// availability probe (architecture doc §21); this loop just RECORDS what
// those requests already taught us and makes it durable.

export interface ProviderStateDoc {
  providerId: string
  generationId: string
  state: 'healthy' | 'open' | 'half_open' | 'absent'
  firstSeenAt: Date
  updatedAt: Date
  consecutiveUnhealthyChecks: number
}

const providerStateSchema = new Schema<ProviderStateDoc>({
  providerId:   { type: String, required: true, unique: true, index: true },
  generationId: { type: String, default: '' },
  state:        { type: String, enum: ['healthy', 'open', 'half_open', 'absent'], default: 'healthy' },
  firstSeenAt:  { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now },
  consecutiveUnhealthyChecks: { type: Number, default: 0 },
})

export const ProviderState =
  (mongoose.models.ProviderState as mongoose.Model<ProviderStateDoc>) ??
  mongoose.model<ProviderStateDoc>('ProviderState', providerStateSchema)

const CHECK_INTERVAL_MS = Number(process.env.RAG_HEALTH_INTERVAL_MS ?? 60_000)
/** After this many consecutive unhealthy checks the provider is considered
 *  DISCONTINUED for routing hints (breakers still decide per-request). */
export const DISCONTINUE_AFTER_CHECKS = Number(process.env.RAG_DISCONTINUE_AFTER_CHECKS ?? 3)

let timer: ReturnType<typeof setInterval> | null = null

async function checkOnce(): Promise<void> {
  const live = new Map(providerHealth().map(h => [h.id, h.state]))
  const gens = new Map(
    providerHealth().map((h, i) => [h.id, listRegisteredGenerations()[i] ?? '']),
  )
  // Union of live providers + previously known ones (so a disappeared
  // provider keeps its history instead of silently vanishing).
  const known = await ProviderState.find({}).select('providerId').lean()
  const ids = new Set<string>([...live.keys(), ...known.map(k => k.providerId)])

  for (const id of ids) {
    const rawState = live.get(id)
    const state: ProviderStateDoc['state'] =
      rawState === 'healthy' || rawState === 'open' || rawState === 'half_open'
        ? rawState
        : 'absent'
    const unhealthy = state !== 'healthy'
    await ProviderState.updateOne(
      { providerId: id },
      unhealthy
        ? {
            $set: { generationId: gens.get(id) ?? '', state, updatedAt: new Date() },
            $inc: { consecutiveUnhealthyChecks: 1 },
          }
        : {
            $set: {
              generationId: gens.get(id) ?? '',
              state,
              updatedAt: new Date(),
              consecutiveUnhealthyChecks: 0,
            },
          },
      { upsert: true },
    ).catch(() => {})
  }
}

/**
 * One supervision pass + durable snapshot. Exported for tests; the interval
 * wrapper is started via startHealthMonitor().
 */
export async function runHealthCheck(): Promise<
  Array<{ providerId: string; generationId: string; state: string; discontinued: boolean }>
> {
  await checkOnce()
  const docs = await ProviderState.find({}).lean()
  return docs.map(d => ({
    providerId: d.providerId,
    generationId: d.generationId,
    state: d.state,
    discontinued: d.consecutiveUnhealthyChecks >= DISCONTINUE_AFTER_CHECKS,
  }))
}

export function startHealthMonitor(): void {
  if (timer) return
  timer = setInterval(() => {
    runHealthCheck().catch(err =>
      logger.warn({ err }, '[rag] health monitor pass failed'),
    )
  }, CHECK_INTERVAL_MS)
  timer.unref()
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, '[rag] health monitor started')
}

export function stopHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}
