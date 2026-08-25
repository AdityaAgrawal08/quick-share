# Quick-Share RAG: Adaptive Embedding and Fault-Tolerant Architecture

## 1. Purpose

This document consolidates the RAG architecture, the Render memory problem, the proposed adaptive embedding strategy, provider failover, model-selection logic, failure recovery, vector-space consistency, resumability, and the operational patterns discussed for Quick-Share.

The central architectural objective is:

> Keep the RAG pipeline reliable under limited infrastructure by treating embedding providers and models as replaceable computation engines while keeping document state, indexing state, and retrieval state owned by Quick-Share.

---

# 2. Current RAG Architecture

Quick-Share currently contains the following pipeline under `signaling-server/src/rag/`:

```text
Document
   |
   v
+-----------+
| Extractor |
+-----+-----+
      |
      v
+-----------+
|  Chunker  |
+-----+-----+
      |
      v
+-----------+
|  Embedder |
+-----+-----+
      |
      v
+-----------+
|   Store   |
+-----------+
```

At query time:

```text
User Question
      |
      v
+-------------+
|  Retriever  |
+------+------+ 
       |
       +------------------+
       |                  |
       v                  v
     BM25          Vector Similarity
       |                  |
       +--------+---------+
                |
                v
        Optional Reranker
                |
                v
              Groq
                |
                v
             Answer
```

The full conceptual system is therefore:

```text
                    DOCUMENT INGESTION

Document
   |
   v
Extractor
   |
   v
Chunker
   |
   v
Embedder
   |
   v
Vector / Chunk Store

                    QUESTION ANSWERING

Question
   |
   v
Retriever
   |
   +-------------------+
   |                   |
   v                   v
 BM25              Embedding Search
   |                   |
   +---------+---------+
             |
             v
        Candidate Chunks
             |
             v
      Optional Reranker
             |
             v
            Groq
             |
             v
           Answer
```

---

# 3. Existing Components

## 3.1 Extractor

File:

```text
signaling-server/src/rag/extractor.ts
```

Purpose:

> Convert files into machine-readable text/content.

Supported formats discussed:

- PDF
- DOCX
- XLSX
- TXT
- Markdown

PDF extraction currently uses `pdf-merge-text` without mmap.
Office formats are processed in memory.

### Scanned PDF handling

A normal PDF may contain actual text:

```text
PDF
 |
 +--> embedded text --> extracted directly
```

A scanned PDF may actually contain page images:

```text
PDF
 |
 +--> page image
       |
       v
      OCR
       |
       v
     text
```

Quick-Share uses Tesseract.js optionally for this OCR path.

OCR is materially more expensive than normal text extraction because image processing and recognition require significantly more CPU and temporary memory.

---

# 4. Chunker

File:

```text
signaling-server/src/rag/chunker.ts
```

The chunker converts a potentially large document into smaller semantic units called chunks.

Example:

```text
Large document
      |
      v
Sentence-aware chunking
      |
      +--> Chunk 1
      +--> Chunk 2
      +--> Chunk 3
      +--> ...
```

The current design uses sentence-aware boundaries and overlap.

## 4.1 Why chunking exists

A complete document may contain tens or hundreds of thousands of tokens. Retrieval becomes more useful when the system can select small relevant pieces instead of passing the whole document to the LLM.

## 4.2 Overlap

Neighboring chunks partially overlap:

```text
Chunk 1:  A B C D E F
                 | | |
Chunk 2:          D E F G H I
```

This reduces the chance that important context is lost exactly at a chunk boundary.

---

# 5. Embedder

File:

```text
signaling-server/src/rag/embedder.ts
```

The embedder converts text into a vector representation.

Example:

```text
"How do users authenticate?"
          |
          v
     Embedding Model
          |
          v
[0.12, -0.42, 0.73, ...]
```

The current local model is:

```text
bge-small-en-v1.5
```

with a 384-dimensional output.

The model runs locally using ONNX Runtime.

## 5.1 Why embeddings exist

Embeddings represent semantic meaning numerically.

For example:

```text
"How do users authenticate?"

and

"The server validates JWT tokens."
```

can be represented by vectors that are closer to each other than an unrelated sentence such as:

```text
"The database stores customer addresses."
```

This enables semantic retrieval.

---

# 6. ONNX Runtime

The model file size is not the same thing as process RAM usage.

Conceptually:

```text
Model file
   |
   v
ONNX Runtime loads model
   |
   +--> model weights
   +--> graph/runtime structures
   +--> input/output tensors
   +--> temporary activations
   +--> allocator arenas
   +--> tokenizer/runtime state
```

Therefore a roughly 90 MB model file can contribute significantly more than 90 MB to resident process memory.

The model is currently intended to load lazily rather than at application boot, which lowers idle memory usage. However, inference still creates a large peak-memory footprint when combined with document processing.

---

# 7. Retriever

File:

```text
signaling-server/src/rag/retriever.ts
```

The retriever combines two search strategies.

## 7.1 BM25

BM25 is keyword-oriented search.

It is particularly useful for exact terminology, identifiers, names, error codes, and technical strings.

Example:

```text
Query: "JWT-401"

Chunk A: "The API returns JWT-401..."   -> strong lexical match
Chunk B: "Database indexing..."         -> weak lexical match
```

## 7.2 Cosine similarity

The question is embedded and compared against chunk embeddings.

```text
Question embedding
        |
        v
cosine similarity
        |
        +--> high similarity -> likely relevant
        +--> low similarity  -> likely irrelevant
```

## 7.3 Hybrid retrieval

The current architecture combines:

```text
BM25 + semantic similarity
```

This is stronger than relying exclusively on either mechanism.

---

# 8. Optional Cross-Encoder Reranker

The retriever can optionally rerank candidates using a cross-encoder model.

Conceptually:

```text
4000 chunks
    |
    v
Hybrid retrieval
    |
    v
50 candidates
    |
    v
Cross-encoder reranker
    |
    v
Top 5-10 chunks
```

The reranker is another machine-learning model and therefore increases memory pressure.

For a 512 MB Render environment, it should remain disabled by default unless measurements prove that sufficient headroom exists.

---

# 9. LLM

File:

```text
signaling-server/src/rag/llm.ts
```

The final answer generation is performed through Groq.

The LLM receives:

```text
User question
      +
Retrieved relevant chunks
      |
      v
     Groq
      |
      v
Generated answer
```

The important distinction is:

```text
Embedding model: text -> vector
LLM:            text + context -> answer
```

The large language model is not running inside the 512 MB Render process, so its model memory is not the primary Render problem.

---

# 10. Pipeline

File:

```text
signaling-server/src/rag/pipeline.ts
```

The pipeline orchestrates extraction, chunking, embedding, storage, recovery, gating, and lifecycle operations.

The current design already includes useful concepts such as:

- resume-from-pending
- per-session job gating
- GC hooks between stages

These should be extended into durable job/work-unit management.

---

# 11. The Current Render Problem

The free Render environment has a 512 MB memory limit for the service.

Quick-Share combines:

```text
Node.js / Express / signaling
+
application dependencies
+
PDF/document parsing
+
large extracted strings
+
chunk arrays
+
ONNX Runtime
+
BGE model
+
input/output tensors
+
temporary allocation buffers
```

During indexing, these allocations overlap.

Conceptually:

```text
                 RENDER FREE
                    512 MB
                      |
         +------------+-------------+
         |                          |
      Base app                  RAG indexing
         |                          |
   Node / Express              PDF buffers
   signaling                   extracted text
   dependencies                chunks
                               tokenizer input
                               ONNX runtime
                               embeddings
                               temporary buffers
         |                          |
         +------------+-------------+
                      |
                      v
                Peak memory
                      |
                      v
                  > 512 MB
                      |
                      v
                    OOM kill
```

The fundamental issue is therefore **peak RSS**, not merely the static model-file size.

---

# 12. Why the Current Pipeline Peaks

A problematic pattern is:

```text
Extract entire document
        |
        v
Create all chunks
        |
        v
Create all embeddings
        |
        v
Store everything
```

For a 4,000-chunk workload, too much data can remain live simultaneously.

A better memory model is:

```text
Document
   |
   v
Small chunk batch
   |
   v
Embed
   |
   v
Persist
   |
   v
Release batch
   |
   v
Next batch
```

The target invariant is:

> Never hold the complete document, all chunks, all embeddings, and all inference buffers at the same time when they do not need to coexist.

---

# 13. Why Local Embeddings Alone Are Not Ideal on Render Free

The local BGE model provides:

- no external embedding API dependency
- no provider quota dependency
- predictable local operation

But it also creates:

- significant resident memory
- inference-time temporary memory
- CPU pressure
- higher probability of Render OOM during indexing

The local model should therefore become a **guaranteed fallback/degraded mode**, rather than necessarily being the primary embedding path.

---

# 14. Proposed New Architecture

The proposed architecture introduces two major layers:

1. **Adaptive workload/model selection**
2. **Embedding provider orchestration and failover**

The conceptual flow is:

```text
                             FILE
                              |
                              v
                      +---------------+
                      | File Analyzer |
                      +-------+-------+
                              |
                    file type / size /
                    structure / OCR /
                    token estimates
                              |
                              v
                     +------------------+
                     | Workload Analyzer|
                     +--------+---------+
                              |
                              v
                     +------------------+
                     | Model Selector    |
                     +--------+---------+
                              |
                              v
                  +-------------------------+
                  | Embedding Orchestrator  |
                  +------------+------------+
                               |
                +--------------+--------------+
                |              |              |
                v              v              v
            Provider A     Provider B      Provider C
                |              |              |
                +--------------+--------------+
                               |
                         all unavailable
                               |
                               v
                         Local BGE/ONNX
                               |
                               v
                         Vector Store
```

---

# 15. File Analyzer

Introduce a component such as:

```text
rag/analyzer/file-analyzer.ts
```

Its purpose is to cheaply inspect the document before expensive indexing begins.

It can derive metadata such as:

```text
file type
file size
page count
number of sheets
row/cell counts
estimated text volume
estimated token count
estimated chunk count
image count
OCR requirement
text density
```

Example analysis result:

```json
{
  "type": "pdf",
  "sizeBytes": 8400000,
  "pages": 180,
  "estimatedTokens": 85000,
  "estimatedChunks": 1100,
  "scannedPages": 60,
  "requiresOcr": true,
  "workloadClass": "high"
}
```

The analyzer should avoid expensive model inference merely to determine the initial routing decision.

---

# 16. File Size Is Not Enough

A critical rule is:

```text
file size != computational complexity
```

Examples:

### Small TXT

```text
200 KB
12,000 tokens
80 chunks
```

This may be low-cost.

### Small scanned PDF

```text
5 MB
300 scanned pages
```

This can be more expensive because OCR is required.

### Large XLSX

A small spreadsheet file may represent tens of thousands of rows and cells.

Therefore the workload estimate should consider more than bytes.

---

# 17. Workload Estimation

Introduce a conceptual workload score:

```text
Workload Score =
    token volume
  + chunk count
  + page count
  + OCR complexity
  + image count
  + table/structured-data complexity
  + extraction complexity
```

The actual numerical weights should be established using benchmarks rather than arbitrary assumptions.

Possible classes:

```text
LOW
MEDIUM
HIGH
VERY_HIGH
```

The score is a scheduling/routing aid rather than a claim about model intelligence.

---

# 18. Model Selection Must Consider More Than Workload

The selected embedding strategy should depend on at least:

```text
workload
retrieval-quality requirement
provider availability
provider quota state
latency
cost
server RAM
server CPU
current concurrency
```

Therefore:

```text
              Model Selection
                    |
       +------------+------------+
       |            |            |
    workload      quality    infrastructure
       |            |            |
       +------------+------------+
                    |
                    v
              model/provider
```

A small file does not automatically mean a poor model should be used. A high-value or retrieval-sensitive document may justify a stronger model even if its raw size is modest.

---

# 19. Embedding Orchestrator

The existing concept of a single `embedder.ts` should evolve into an abstraction such as:

```text
rag/embedding/
├── orchestrator.ts
├── provider.ts
├── selector.ts
├── health.ts
├── quota.ts
├── circuit-breaker.ts
├── model-registry.ts
└── providers/
    ├── google.ts
    ├── provider-b.ts
    ├── provider-c.ts
    └── local-bge.ts
```

The critical abstraction is:

```text
EmbeddingProvider
```

rather than hard-coding one specific service.

Each provider should expose the same conceptual contract:

```text
embed(chunks) -> vectors
```

The orchestration layer decides which provider implements that operation.

---

# 20. Provider Priority

The system should have an ordered preference, but priority must not mean "always call provider A first regardless of state."

Instead:

> Choose the highest-priority provider that is currently eligible.

Eligibility should consider:

```text
provider enabled?
model compatible?
quota believed sufficient?
provider healthy?
provider circuit open?
request size acceptable?
latency acceptable?
server resources acceptable?
```

Conceptually:

```text
Preferred provider healthy + quota available
            |
           YES -> use
            |
           NO
            v
Next compatible provider
            |
           YES -> use
            |
           NO
            v
Continue through candidates
            |
           none
            v
Local fallback / pause
```

---

# 21. Problem: Checking Provider Availability Consumes Quota

A naive design might do:

```text
"Let's send a test embedding to Provider A."
               |
               v
       provider health check
               |
               v
actual embedding request
```

This is inefficient because the health check itself can consume request/token quota.

Therefore:

> Do not use real embedding requests as routine availability probes.

Instead, availability should be inferred from multiple sources.

---

# 22. Provider Capability vs Provider Availability

These are different questions.

### Capability

Can the provider/model technically perform this operation?

This can often be known from static model metadata and local configuration.

### Availability

Will the provider accept the request right now?

This cannot be known with absolute certainty before making the actual production request.

Therefore:

```text
Static metadata
       +
Local quota estimate
       +
Recent health state
       +
Provider documentation/configuration
       |
       v
Best-effort routing decision
       |
       v
REAL PRODUCTION REQUEST
       |
       v
Actual result becomes the strongest health signal
```

This is a standard distributed-systems principle: predicted availability is not equivalent to guaranteed transaction success.

---

# 23. Local Quota Tracking

Maintain provider state locally.

Conceptually:

```text
Provider State

Provider A
  model: X
  quota estimate: 73%
  last 429: none
  cooldown: none
  health: healthy

Provider B
  model: X
  quota estimate: 42%
  last 429: recent
  cooldown: active
  health: degraded

Local BGE
  quota: local
  RAM requirement: known/measured
  health: memory-constrained
```

The exact provider quota state may never be perfectly known, so the values should be treated as estimates based on:

- requests made
- estimated tokens consumed
- provider-provided rate-limit information where available
- recent errors
- documented reset windows

---

# 24. Token/Workload Estimation Before Requests

For a document with approximately:

```text
4,000 chunks
x
120 estimated tokens per chunk
```

expected work is approximately:

```text
480,000 input tokens
```

The orchestrator can compare this against its current estimated provider capacity before selecting a provider.

This avoids wasting actual inference requests purely to discover that there is clearly insufficient capacity.

Exact token-count endpoints may exist for some providers, but calling a token-counting endpoint for every small batch may itself create unnecessary operational overhead. Prefer local estimation for normal scheduling and exact provider-side counting only where it provides meaningful value.

---

# 25. Production Requests Are the Final Availability Test

No quota estimate can perfectly predict the next request.

Therefore:

```text
local state
   |
   v
provider selection
   |
   v
real embedding request
   |
   +--> success -> update health + quota state
   |
   +--> failure -> classify + update state + retry/fallback
```

The embedding request itself becomes the definitive operational signal.

---

# 26. Provider Error Classification

A provider failure should not automatically trigger the same response for every status.

Conceptual classification:

```text
401
 -> authentication/configuration problem
 -> disable provider until configuration is corrected

400
 -> request/application problem
 -> do not blindly hide the bug through fallback

429
 -> rate limit/quota pressure
 -> mark provider degraded/open circuit and fallback

408 / timeout
 -> transient failure
 -> retry according to policy, then fallback

500 / 503
 -> provider-side failure
 -> retry/fallback according to policy
```

The exact mapping must follow each provider's API semantics.

---

# 27. Circuit Breaker

The provider should have health states.

```text
             failure threshold
HEALTHY --------------------------> OPEN
   ^                                  |
   |                                  | cooldown
   |                                  v
   +---------------------------- HALF_OPEN
                success
```

### HEALTHY

Normal requests are allowed.

### OPEN

Provider is temporarily excluded because continuing to call it is unlikely to help.

### HALF_OPEN

After a cooldown, allow a limited attempt to determine whether service has recovered.

This avoids repeatedly spending quota on a provider already known to be failing.

---

# 28. Second Major Problem: Provider Disappears Halfway

Suppose the document contains 4,000 chunks.

Provider B processes:

```text
chunks 1-2000 -> successful
```

Then it disappears.

A weak system has:

```text
Document status = FAILED
```

and may restart everything.

The proposed system instead models the document as a collection of durable work units.

---

# 29. Chunk-Level Durable Work Units

Instead of:

```text
JOB = all 4,000 chunks
```

use:

```text
JOB
 |
 +--> chunk 0001
 +--> chunk 0002
 +--> chunk 0003
 +--> ...
 +--> chunk 4000
```

Each work unit has a persistent state.

Possible states:

```text
PENDING
PROCESSING
COMPLETED
FAILED
```

Additional states can be added later if needed, such as `RETRYING`, `CANCELLED`, or `BLOCKED`.

---

# 30. Durable Per-Chunk State

Example:

```text
chunk_id   status       embedding_generation
------------------------------------------------
001        COMPLETED    gemini-v1
002        COMPLETED    gemini-v1
...
2000       COMPLETED    gemini-v1
2001       PENDING      -
...
4000       PENDING      -
```

Now a provider failure does not destroy the information about work that already completed.

---

# 31. Canonical Chunk Store

A major architectural change is to persist canonical chunks independently of embeddings.

The canonical document representation should contain fields conceptually like:

```text
chunk_id
 document_id
 sequence_number
 text
 page_number
 source_location
 content_hash
 metadata
```

Example:

```text
chunk_183
 document_27
 page 42
 hash abc123
 text = "Authentication is performed..."
```

This becomes the authoritative document representation.

---

# 32. Separate Canonical Data from Embedding Representation

The architecture should become:

```text
                 CANONICAL DOCUMENT DATA
                          |
                          v
                    Canonical Chunks
                          |
              +-----------+-----------+
              |                       |
              v                       v
        Embedding Generation 1   Embedding Generation 2
              |                       |
              v                       v
        Vector Index V1         Vector Index V2
```

This separation is critical.

The original document is the source.
Canonical chunks are the stable intermediate representation.
Embeddings are derived representations.

Therefore embedding providers become replaceable.

---

# 33. Provider Failure Recovery

Suppose:

```text
Document = 4,000 chunks

Provider B / Model X
chunks 1-2,000 -> COMPLETE
provider fails
chunks 2,001-4,000 -> PENDING
```

The recovery process is:

```text
Provider B fails
      |
      v
Classify failure
      |
      v
Update provider health
      |
      v
Find incomplete work
      |
      v
Check compatible provider for Model X
      |
      +--> available -> continue
      |
      +--> unavailable -> pause/retry later
```

The job does not re-extract the PDF merely because the embedding provider failed.

---

# 34. Provider Failover vs Model Failover

These must be distinguished.

## Provider failover

Example:

```text
Provider B
Model X
   |
   v
Provider B unavailable
   |
   v
Provider C
Model X
```

This is ideal because the embedding space remains compatible.

## Model failover

Example:

```text
Provider B
Model X
   |
   v
Model X unavailable everywhere
   |
   v
Model Y
```

This changes the embedding space.

It should therefore be treated as a **new embedding generation**, not as an invisible continuation inside the same vector index.

---

# 35. Why Vectors from Different Models Cannot Simply Be Mixed

A 384-dimensional vector is not a universal coordinate system.

For example:

```text
Model X
"authentication"
     -> vector X

Model Y
"authentication"
     -> vector Y
```

Even if both vectors happen to have the same dimension:

```text
384 dimensions
```

the dimensions do not necessarily encode the same learned feature space.

Therefore this is invalid as a silent design:

```text
Document chunks 1-2000 -> Model X
Document chunks 2001-4000 -> Model Y

Question -> Model X

Search one mixed index
```

unless the system explicitly supports and evaluates multiple generations/indexes.

---

# 36. What Can Be Done With Already-Computed Vectors?

They do **not** need to be physically deleted simply because the provider failed.

They are still valid for the model/generation that created them.

They can be:

1. kept in their current generation/index;
2. used while that generation remains active;
3. queried as part of a multi-index strategy if the retrieval layer supports it;
4. retained during a migration;
5. discarded later after a new generation becomes active.

The problem is not that the vectors are bad.

The problem is that vectors from different embedding spaces must not be silently treated as one homogeneous vector space.

---

# 37. Embedding Generations

Introduce an explicit concept:

```text
embedding_generation_id
```

Example:

```text
Generation 1
  provider: B
  model: Model-X
  dimension: 384
  status: partial

Generation 2
  provider: C
  model: Model-Y
  dimension: 768
  status: building
```

Every embedding record should identify its generation.

Conceptually:

```text
embedding
---------
chunk_id
embedding_generation_id
model_id
provider_id
vector
created_at
```

---

# 38. Strategy 1 for Model Failure: Wait for Recovery

If Provider B temporarily disappears, the first action should not necessarily be to switch models.

Instead:

```text
Model X unavailable temporarily
       |
       v
Pause job
       |
       v
Wait / retry after cooldown
       |
       v
Continue using Model X
```

This preserves index consistency and avoids unnecessary re-embedding.

---

# 39. Strategy 2: Fail Over to Another Provider Offering the Same Model

This is the preferred production failover path whenever possible.

```text
                    Model X
                       |
          +------------+-------------+
          |                          |
       Provider B                 Provider C
          |                          |
          +------------+-------------+
                       |
                   same vector space
```

Provider failure does not force a model change.

---

# 40. Strategy 3: Build a New Generation

If the only remaining option is a different model:

```text
Canonical Chunks
       |
       +-----------------------+
       |                       |
       v                       v
Generation 1              Generation 2
Model X                   Model Y
       |                       |
       v                       v
Index V1                   Index V2
```

Generation 1 can remain active while Generation 2 is being built.

Once Generation 2 reaches a valid completion threshold, the system can switch the active generation atomically.

This resembles a blue/green deployment strategy for vector indexes.

---

# 41. Why Re-Embedding Does Not Require Re-Reading the Original File

This is one of the most important architectural benefits of canonical chunk storage.

Initial ingestion:

```text
Original file
    |
    v
Extract
    |
    v
Chunk
    |
    v
Canonical Chunks   <--- persisted
```

Later model migration:

```text
Canonical Chunks
    |
    v
New Embedding Model
    |
    v
New Vector Index
```

Therefore, if the embedding model changes:

```text
NO PDF re-extraction required
NO DOCX re-extraction required
NO OCR required again
NO re-chunking required
```

unless the extraction/chunking algorithms themselves changed.

---

# 42. Agent Model Switching: General Principle

Systems that dynamically switch LLMs do not normally transfer a magical internal model state from Model A to Model B.

The application owns the durable state.

For an agent, that state may include:

```text
conversation
files
repository state
tool results
pending tasks
execution state
```

For Quick-Share RAG, the equivalent state is:

```text
document
canonical chunks
chunk metadata
job state
embedding generation
vector index state
provider health
```

The model/provider is a replaceable computation engine.

The application is the source of truth.

---

# 43. Silent Provider Failure Detection

Use multiple mechanisms.

## 43.1 Request timeout

Every request has a deadline.

```text
Request sent
    |
    v
Timer
    |
    +--> response -> success
    |
    +--> timeout -> failure
```

## 43.2 Batch accounting

If 32 inputs are submitted, the system must know that 32 outputs are required.

```text
Requested: 32
Returned:  32 -> success
Returned:  31 -> partial failure
Returned:  0  -> failure
```

Incomplete batches must not be marked fully completed.

## 43.3 Persistent job lease

A worker acquires a lease:

```text
status = PROCESSING
worker_id = provider-b-7
lease_until = T
```

If the worker dies and the lease expires:

```text
PROCESSING
      |
lease expires
      |
      v
PENDING / RETRYABLE
```

Another worker/provider can take the work.

---

# 44. Durable Completion Ordering

Never do:

```text
Provider response
      |
      v
mark COMPLETED
      |
      v
try database write
```

Instead:

```text
Provider response
      |
      v
Validate vector
      |
      v
Persist vector durably
      |
      v
Transaction succeeds
      |
      v
Mark work COMPLETED
```

The database/index is the authoritative source of completion, not the transient provider response.

---

# 45. Idempotency

Network failures can occur after the provider has completed work but before Quick-Share receives the response.

Example:

```text
Client -> Provider
Provider computes vector
Provider -> network failure
Quick-Share receives nothing
```

Quick-Share may retry.

The operation should therefore be idempotent at the storage layer.

Use stable keys such as:

```text
(document_id,
 chunk_id,
 embedding_generation_id)
```

with a uniqueness constraint or equivalent idempotent write semantics.

A retry then becomes:

```text
already exists -> treat as successful/reconcile state
```

instead of producing duplicate vectors.

---

# 46. Recommended Work Unit Size

For a 512 MB environment, use small embedding batches.

A starting point such as:

```text
16-32 chunks per batch
```

is reasonable for benchmarking, but the exact value must be measured.

The objective is not maximum throughput.

The objective is bounded peak memory.

---

# 47. Concurrency Policy

On the 512 MB free instance, the default should be close to:

```text
embedding concurrency = 1
indexing concurrency  = 1
reranker concurrency  = 0 by default
```

Conceptually:

```text
Job A
  |
  v
Embedding batch
  |
  v
Store
  |
  v
Next batch
```

rather than:

```text
Job A ─┐
Job B ─┼--> simultaneous model inference
Job C ─┘
```

Concurrency multiplies transient memory consumption.

---

# 48. Streaming / Bounded Processing

The indexing path should avoid retaining the entire workload simultaneously.

Preferred pattern:

```text
extract small amount
      |
      v
chunk
      |
      v
batch 16-32
      |
      v
embed
      |
      v
persist
      |
      v
release
      |
      v
next batch
```

Approximate memory behavior becomes closer to:

```text
O(page_size + batch_size + model_runtime)
```

instead of:

```text
O(complete_document + all_chunks + all_embeddings + model_runtime)
```

---

# 49. Local BGE Optimization

If local embedding remains necessary, first optimize it rather than abandoning it.

Potential strategies discussed:

- quantized BGE model
- smaller embedding model such as MiniLM-class models if quality remains acceptable
- bounded batches
- reduced concurrency
- careful ONNX Runtime memory configuration
- disposable worker/process boundaries for lifecycle isolation

The local model should remain a guaranteed final fallback.

---

# 50. Disposable Embedding Worker

An optional architecture is to isolate the ONNX model in a worker process.

```text
                 Main process
                      |
                 indexing job
                      |
                      v
               Embedding worker
                      |
                 ONNX Runtime
                      |
                     BGE
```

When the worker terminates, the operating system can reclaim its address space.

This is particularly useful for preventing long-lived runtime allocations from accumulating across jobs.

However:

> A worker process does not bypass Render's 512 MB service limit. Its purpose is memory lifecycle isolation, not increasing the total memory budget.

---

# 51. Browser-Side Embeddings as a Long-Term Option

An alternative architecture is to run embeddings in the user's browser.

```text
Browser
  |
  +--> extract
  +--> chunk
  +--> embed
          |
          v
       vectors
          |
          v
       Render
          |
          +--> store
          +--> BM25
          +--> retrieval
          +--> Groq
```

Advantages:

- server does not permanently load embedding model
- server memory pressure decreases
- no external embedding API is required
- document processing can remain local to the user

Tradeoffs:

- client CPU can be slow
- model download is required
- mobile devices may be constrained
- browser/runtime compatibility varies
- retrieval infrastructure becomes more complex

This is better viewed as a longer-term architecture rather than the immediate Render fix.

---

# 52. Why a Second Free Render Service Is Not a Complete Solution

Moving the embedding model to another free service does not remove the memory constraint if that service has the same resource limit.

It merely moves the same workload to another 512 MB environment.

A separate worker service becomes useful when it can be given materially different resources.

---

# 53. Why BM25-Only Is Not Preferred

Removing embeddings completely would simplify the memory problem:

```text
Document
  |
  v
BM25
  |
  v
LLM
```

But it eliminates semantic retrieval.

For example:

```text
Question:
"How are users authenticated?"

Document:
"JWT tokens are validated by the authorization middleware."
```

BM25 may have weak lexical overlap while semantic search can identify the conceptual relationship.

Therefore BM25-only should be an emergency fallback, not the preferred architecture.

---

# 54. Retrieval Architecture Under Multiple Generations

If multiple embedding generations coexist, retrieval must be explicit.

Option 1: one active generation

```text
Question
   |
   v
Active embedding model
   |
   v
Active vector index
```

Option 2: multi-generation retrieval

```text
Question
   |
   +------------+-------------+
   |                          |
   v                          v
Index V1                   Index V2
Model X                    Model Y
   |                          |
   +------------+-------------+
                |
                v
       merge / normalize / rank
```

Multi-generation retrieval is significantly more complex and should not be the default Quick-Share design unless there is a concrete need.

---

# 55. Recommended Production Policy for Quick-Share

The following order is recommended.

```text
1. Analyze document.

2. Determine workload and quality requirements.

3. Determine the required embedding model tier/specification.

4. Select a compatible provider using local state:
   - health
   - quota estimate
   - cooldown state
   - latency
   - cost
   - current server resources

5. Persist canonical chunks before embedding.

6. Process small durable batches.

7. Persist every successful batch immediately.

8. Track per-chunk/per-batch completion state.

9. On provider failure:
   - classify failure
   - retry transient failures
   - trip circuit breaker where appropriate
   - switch to another provider of the SAME model first

10. If the model itself must change:
    create a new embedding generation.

11. Reuse canonical chunks.

12. Build the new vector index separately.

13. Activate the new generation atomically when complete.

14. Garbage-collect the old generation later.

15. Use local BGE as the final fallback when no suitable
    external provider is usable.
```

---

# 56. Final Target Architecture

```text
                              QUICK-SHARE RAG

                                   FILE
                                    |
                                    v
                           +------------------+
                           |   File Analyzer  |
                           +--------+---------+
                                    |
                  +-----------------+------------------+
                  |                 |                  |
                 type              size            structure
                  |                 |                  |
                  +-----------------+------------------+
                                    |
                                    v
                           +------------------+
                           | Workload Analyzer|
                           +--------+---------+
                                    |
                                    v
                           +------------------+
                           |  Model Selector  |
                           +--------+---------+
                                    |
                                    v
                           +----------------------+
                           | Canonical Extraction |
                           | + Chunking            |
                           +----------+-----------+
                                      |
                                      v
                            +--------------------+
                            | Canonical Chunk DB |
                            +----------+---------+
                                       |
                                       v
                         +-----------------------------+
                         | Embedding Orchestrator     |
                         +-------------+---------------+
                                       |
                   +-------------------+-------------------+
                   |                   |                   |
                   v                   v                   v
               Provider A         Provider B          Provider C
               preferred          fallback             fallback
                   |                   |                   |
                   +-------------------+-------------------+
                                       |
                                 all unavailable
                                       |
                                       v
                               Local BGE / ONNX
                                       |
                                       v
                             Embedding Generation
                                       |
                                       v
                               Vector Index
                                       |
                        +--------------+--------------+
                        |                             |
                        v                             v
                       BM25                    Vector Search
                        |                             |
                        +--------------+--------------+
                                       |
                                       v
                              Hybrid Retrieval
                                       |
                                       v
                                Optional Reranker
                                       |
                                       v
                                      Groq
                                       |
                                       v
                                     ANSWER
```

---

# 57. Failure-Recovery Flow

```text
                     Start indexing
                           |
                           v
                    Analyze document
                           |
                           v
                    Store canonical chunks
                           |
                           v
                    Select provider/model
                           |
                           v
                    Process small batch
                           |
                           v
                     Provider request
                           |
                +----------+----------+
                |                     |
              success               failure
                |                     |
                v                     v
        Persist embeddings      Classify error
                |                     |
                v             +-------+--------+
          mark completed       |       |        |
                |             429    timeout   400/401
                |               |       |        |
                |               v       v        v
                |            cooldown retry   config/request fix
                |               |       |
                |               +---+---+
                |                   |
                |                   v
                |             compatible provider?
                |                   |
                |             +-----+------+
                |             |            |
                |            YES           NO
                |             |            |
                |             v            v
                |          continue      pause/retry
                |                         or
                |                       new model generation
                |                              |
                +------------------------------+
                               |
                               v
                       More chunks pending?
                               |
                       +-------+-------+
                       |               |
                      YES              NO
                       |               |
                       v               v
                  next batch       indexing complete
```

---

# 58. Model-Generation Migration Flow

```text
                  Existing canonical chunks
                           |
                           v
                    Generation 1 active
                         Model X
                           |
                    Model X unavailable
                           |
                           v
                Is another provider available
                      for Model X?
                           |
                 +---------+---------+
                 |                   |
                YES                  NO
                 |                   |
                 v                   v
           continue Model X      create Generation 2
                                      |
                                      v
                                  Model Y
                                      |
                                      v
                            Re-embed canonical chunks
                                      |
                                      v
                               Build Index V2
                                      |
                                      v
                             Validate completeness
                                      |
                                      v
                           Activate Generation 2
                                      |
                                      v
                           Retire Generation 1
```

---

# 59. State Model

A useful conceptual state model is:

```text
Document
  |
  +--> RECEIVED
  |
  +--> ANALYZED
  |
  +--> EXTRACTED
  |
  +--> CHUNKED
  |
  +--> READY_FOR_EMBEDDING
  |
  +--> EMBEDDING
  |
  +--> COMPLETE
  |
  +--> PAUSED
  |
  +--> FAILED
```

Individual chunks/work units should separately track:

```text
PENDING
PROCESSING
COMPLETED
FAILED
```

Embedding records additionally identify their embedding generation.

---

# 60. Suggested Core Data Model

A conceptual schema can look like:

```text
Document
--------
document_id
filename
mime_type
size_bytes
analysis_metadata
created_at
status
active_embedding_generation_id
```

```text
Chunk
-----
chunk_id
document_id
sequence_number
text
page_number
source_location
content_hash
metadata
```

```text
EmbeddingGeneration
-------------------
generation_id
document_id
provider_id
model_id
model_version
dimension
status
created_at
completed_at
```

```text
Embedding
---------
chunk_id
generation_id
vector
created_at
```

```text
EmbeddingJob
------------
job_id
document_id
generation_id
status
current_progress
lease_owner
lease_until
retry_count
last_error
created_at
updated_at
```

```text
ProviderState
-------------
provider_id
model_id
health_state
failure_count
last_success_at
last_failure_at
cooldown_until
estimated_quota_state
last_error_code
latency_metrics
```

The exact persistence technology is implementation-specific.

---

# 61. Important Invariants

The system should explicitly enforce the following invariants.

### Invariant 1: Application owns state

```text
Provider is replaceable.
Quick-Share state is authoritative.
```

### Invariant 2: Canonical chunks are durable

Once extraction/chunking succeeds, model/provider changes should not require re-reading the source file.

### Invariant 3: Embeddings identify their generation

No embedding is stored without identifying the model/generation that produced it.

### Invariant 4: No silent vector-space mixing

Vectors from incompatible models are never silently combined into one index.

### Invariant 5: Completion is durable

A work unit becomes complete only after its result is durably stored.

### Invariant 6: Work is idempotent

Retries must not create duplicate logical embeddings.

### Invariant 7: Provider probing is minimized

Real inference requests should perform useful work rather than being spent as routine health checks.

### Invariant 8: Memory is bounded

Indexing should process small batches and avoid retaining the entire workload in memory.

---

# 62. What the Architecture Solves

This architecture addresses the original problems in several independent dimensions.

## Render memory

API-first embedding keeps the large embedding model out of the main process under normal conditions.

## API outages

A provider outage does not necessarily fail the indexing operation.

## API rate limits

The orchestrator can pause/cool down a provider and use a compatible fallback.

## Provider disappearance halfway through a job

Durable work-unit state lets the system resume from the last confirmed completion boundary.

## Model changes

Embedding generations make model migration explicit instead of corrupting an existing vector index.

## Re-reading documents

Canonical chunks allow re-embedding without repeating extraction/OCR/chunking.

## Duplicate work

Idempotent writes prevent retries from creating duplicate embeddings.

## Long-running provider failures

Circuit breakers prevent repeated wasteful calls to an unhealthy provider.

## Variable document complexity

The workload analyzer allows resource and model selection to adapt to the actual document.

---

# 63. Recommended Immediate Implementation Order

The architecture can be introduced incrementally.

```text
Phase 1
------
Bound indexing memory
- streaming/bounded batches
- concurrency = 1
- reranker disabled
- no all-embeddings-in-memory

Phase 2
------
Separate canonical chunks from embeddings
- persist chunks
- add chunk IDs
- add hashes

Phase 3
------
Introduce embedding provider abstraction
- EmbeddingProvider interface
- local BGE becomes one provider

Phase 4
------
Introduce provider orchestration
- priority
- quota estimates
- health state
- error classification
- circuit breaker

Phase 5
------
Introduce durable embedding jobs
- per-batch/per-chunk state
- leases
- retries
- idempotent writes

Phase 6
------
Introduce embedding generations
- generation IDs
- separate indexes
- active generation pointer

Phase 7
------
Add adaptive workload/model selection
- file analyzer
- workload estimator
- model policy

Phase 8
------
Add stronger provider redundancy
- same-model provider failover
- alternate model migration

Phase 9
------
Optional browser-side embedding / advanced deployment
```

---

# 64. Final Architecture Principle

The original design can be summarized as:

```text
Document
  |
  v
Extract -> Chunk -> Embed -> Store
```

The proposed production architecture becomes:

```text
Document
   |
   v
Analyze
   |
   v
Extract / OCR
   |
   v
Chunk
   |
   v
Persist canonical chunks
   |
   v
Adaptive model selection
   |
   v
Embedding orchestrator
   |
   +--> preferred provider
   +--> compatible provider fallback
   +--> retry/circuit breaker
   +--> local model fallback
   |
   v
Durable embedding generation
   |
   v
Vector index
   |
   v
Hybrid retrieval
   |
   v
Optional reranking
   |
   v
Groq LLM
   |
   v
Grounded answer
```

The core conceptual shift is:

> **The embedding provider is not the owner of the indexing job. It is only an execution backend.**

Quick-Share owns the document, canonical chunks, job state, generation identity, and completed work. Because of that, an external model can disappear, a provider can hit a rate limit, a server can restart, or the active model can change without forcing the entire RAG system to start from the original file again.

That is the architectural foundation for making Quick-Share's RAG layer resilient, adaptive, and compatible with constrained infrastructure.
