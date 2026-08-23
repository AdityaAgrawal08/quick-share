"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("./logger"));
// Load .env manually if not handled by external runner
const envPath = path_1.default.resolve(__dirname, '../.env');
if (fs_1.default.existsSync(envPath)) {
    fs_1.default.readFileSync(envPath, 'utf8')
        .split('\n')
        .forEach((rawLine) => {
        const line = rawLine.trim().replace(/\r$/, '');
        if (!line || line.startsWith('#'))
            return;
        const eq = line.indexOf('=');
        if (eq <= 0)
            return;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        // Strip surrounding quotes so PASSWORD="secret" doesn't keep the quotes.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && !(key in process.env))
            process.env[key] = value;
    });
}
exports.CONFIG = {
    PORT: parseInt(process.env.PORT ?? '3001', 10),
    MONGODB_URI: process.env.MONGODB_URI, // Optional, enables stored mode
    MONGODB_TLS_INSECURE: process.env.MONGODB_TLS_INSECURE === 'true' || process.env.MONGODB_TLS_INSECURE === '1',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : [],
    SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10),
    STORED_MAX_BYTES: 10 * 1024 * 1024,
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    NODE_ENV: process.env.NODE_ENV || 'development',
    // ── RAG agent ──────────────────────────────────────────────────────────
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    RAG_ENABLED: process.env.RAG_ENABLED !== 'false',
    EMBED_MODEL: process.env.RAG_EMBED_MODEL || 'Xenova/bge-small-en-v1.5',
    RERANK_MODEL: process.env.RAG_RERANK_MODEL || 'Xenova/bge-reranker-base',
    // Cross-encoder reranking adds ~400MB resident RAM — off by default so the
    // app fits small free-tier hosts (Render 512MB). Fusion ranking alone
    // scored hit@3=1.0 on the eval set. Opt in only on ≥1GB instances.
    RAG_RERANK_ENABLED: process.env.RAG_RERANK_ENABLED === 'true',
    CHUNK_SIZE_CHARS: parseInt(process.env.RAG_CHUNK_SIZE ?? '600', 10),
    CHUNK_OVERLAP_CHARS: parseInt(process.env.RAG_CHUNK_OVERLAP ?? '90', 10),
    MAX_CHUNKS_PER_SESSION: parseInt(process.env.RAG_MAX_CHUNKS ?? '4000', 10),
};
// Validation
if (exports.CONFIG.NODE_ENV === 'production') {
    if (exports.CONFIG.ALLOWED_ORIGINS.includes('*')) {
        logger_1.default.warn('Security Warning: ALLOWED_ORIGINS is set to "*" in production.');
    }
    if (!exports.CONFIG.MONGODB_URI) {
        logger_1.default.warn('Running in production without MONGODB_URI (Stored Mode disabled).');
    }
}
logger_1.default.info({
    msg: 'Configuration loaded',
    port: exports.CONFIG.PORT,
    origins: exports.CONFIG.ALLOWED_ORIGINS,
    storedMode: !!exports.CONFIG.MONGODB_URI,
    mongoTlsInsecure: exports.CONFIG.MONGODB_TLS_INSECURE
});
