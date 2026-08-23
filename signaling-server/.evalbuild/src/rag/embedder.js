"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEmbedder = getEmbedder;
exports.embedTexts = embedTexts;
exports.embedQuery = embedQuery;
exports.preloadEmbedder = preloadEmbedder;
const transformers_1 = require("@huggingface/transformers");
const config_1 = require("../config");
const logger_1 = __importDefault(require("../logger"));
// ── Embeddings (local CPU via ONNX) ──────────────────────────────────────────
// bge-small-en-v1.5 → 384-dim normalized vectors. Model weights (~25MB q8)
// download once to disk cache on first use, then load from disk.
//
// Singleton with in-flight dedup: concurrent index jobs share one pipeline.
// A failure here must NEVER crash the process — callers convert rejections
// into session aiStatus='failed'.
transformers_1.env.allowLocalModels = false;
// Optional explicit cache dir (used by CI to cache model weights between runs).
if (process.env.HF_CACHE_DIR)
    transformers_1.env.cacheDir = process.env.HF_CACHE_DIR;
let extractorPromise = null;
async function makeExtractor() {
    const start = Date.now();
    const pipe = await (0, transformers_1.pipeline)('feature-extraction', config_1.CONFIG.EMBED_MODEL, {
        dtype: 'q8',
    });
    logger_1.default.info({ ms: Date.now() - start, model: config_1.CONFIG.EMBED_MODEL }, '[rag] embedder loaded');
    return pipe;
}
function getEmbedder() {
    if (!extractorPromise) {
        extractorPromise = makeExtractor().catch((err) => {
            extractorPromise = null; // allow retry on next call
            throw err;
        });
    }
    return extractorPromise;
}
/** Embed a batch of texts into normalized vectors. */
async function embedTexts(texts) {
    if (texts.length === 0)
        return [];
    const extractor = await getEmbedder();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
}
async function embedQuery(text) {
    // Chunker already prefixes file/page context; plain symmetric encoding
    // works well with bge-small v1.5 for this corpus shape.
    const [vec] = await embedTexts([text]);
    return vec;
}
async function preloadEmbedder() {
    try {
        await getEmbedder();
    }
    catch (err) {
        logger_1.default.error({ err }, '[rag] embedder preload failed — will retry on first use');
    }
}
