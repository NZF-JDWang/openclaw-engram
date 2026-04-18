# Engram

<p align="center">
  <img src="engram-hero.png" alt="Engram — Unified OpenClaw Memory System" width="800">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="Status">
  <img src="https://img.shields.io/badge/OpenClaw-plugin-blueviolet" alt="OpenClaw Plugin">
  <img src="https://img.shields.io/badge/kind-context--engine-orange" alt="Context Engine">
</p>

**Engram** is a unified OpenClaw memory plugin that replaces three separate systems — lossless-claw, qmd, and precog — with one in-process SQLite-backed engine.

It combines:

| Layer | Replaces | What it does |
|-------|----------|--------------|
| **Context Engine** | lossless-claw | Persistent transcript storage with DAG-based multi-level compaction |
| **Knowledge Base** | qmd | Local search over files, directories, and session summaries (BM25 + FTS5 + optional vectors) |
| **Proactive Recall** | precog | Injects persona, approved facts, and relevant KB results before each prompt build |

## Architecture

```
+------------------------------------------------------------------+
|                             Engram                                |
|                                                                   |
|  +------------------+  +------------------+  +------------------+  |
|  |  Context Engine  |  |  Knowledge Base  |  | Recall Injector  |  |
|  |                  |  |                  |  |                  |  |
|  |  * messages      |  |  * kb_chunks     |  |  * persona       |  |
|  |  * summaries     |  |  * kb_docs       |  |  * facts         |  |
|  |  * context_items |  |  * kb_embeds     |  |  * KB results    |  |
|  |                  |  |  * kb_facts      |  |                  |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
|           |                     |                     |           |
|           +---------------------+---------------------+           |
|                                 |                                 |
|                     +-----------+-----------+                     |
|                     | engram.db (SQLite)  |                     |
|                     +---------------------+                     |
+------------------------------------------------------------------+
```

All three layers share a single `engram.db` SQLite database. No subprocesses, no native binaries, no cross-repo dependencies.

## Key Features

### Context Engine
- **Persistent transcript storage** — every message, every turn, never lost
- **DAG-based compaction** — leaf summaries (depth 0) → condensed summaries (depth 1+) → depth 2+, forming a compression hierarchy
- **Three-level escalation** — normal summarization → aggressive → extractive TF-IDF fallback (always succeeds, no LLM required)
- **Session continuity** — `session_end_artifacts` carry goals, decisions, and open questions between sessions
- **Per-session factory** — each session gets its own DB handle, eliminating the "database is not open" singleton crash

### Knowledge Base
- **BM25 + FTS5** full-text search over imported files, directories, and session summaries
- **Optional vector embeddings** — generate and store embeddings for semantic reranking
- **Auto-indexing** — configured collections sync on startup; session summaries index automatically
- **Obsidian vault support** — point engram at your vault and everything becomes searchable
- **Temporal decay** — older documents rank lower by default

### Proactive Recall
- **Persona injection** — always-on personality context via `prependSystemContext`
- **Approved facts** — explicitly stored, reviewed, and injected when relevant
- **KB recall** — relevant knowledge base chunks surfaced before each model turn
- **Duplicate suppression** — skips results already present in recent context
- **Confidence gating** — only injects when scores exceed configurable thresholds
- **Score: 0.55** minimum, **3 results** max, **80+80 tokens** budget

### Data Lifecycle
- **Storage-time truncation** — messages and parts capped at 32KB to prevent bloat
- **Summary-driven pruning** — once a conversation is summarized to depth ≥ 1, raw messages can be pruned after 90 days
- **Scheduled compaction** — nightly depth-3+ compaction keeps the summary DAG healthy
- **Scheduled maintenance** — daily VACUUM, WAL checkpoint, ANALYZE
- **Quality pipeline** — strips base64, raw metadata, and truncated content before storage; flags short/broken summaries for re-summarization

## Commands

| Command | Description |
|---------|-------------|
| `/engram` | Status overview (DB size, message count, summary depth distribution) |
| `/engram doctor` | Health check and diagnostics |
| `/engram search <query>` | Search the knowledge base |
| `/engram get <id>` | Retrieve a document or chunk by ID |
| `/engram index <path>` | Index a file or directory into the KB |
| `/engram migrate` | Migrate from lossless-claw or qmd |
| `/engram migrate --dry-run` | Preview migration without writing |
| `/engram maintain` | VACUUM, WAL checkpoint, ANALYZE, size warning |
| `/engram compact` | Force full compaction of current session |
| `/engram review` | Review pending facts for approval |
| `/engram conflicts` | Show conflicting facts |
| `/engram approve <factId>` | Approve a pending fact |
| `/engram reject <factId>` | Reject a pending fact |
| `/engram persona` | Read current persona |
| `/engram persona set <text>` | Set persona text |
| `/engram export [path]` | Export all memories to markdown |
| `/engram forget <id> [reason]` | Retire a KB entry |

## Tools

| Tool | Description |
|------|-------------|
| `engram_status` | DB size, message count, summary depth distribution, recall latency |
| `engram_search` | Search the KB with BM25 + optional vector reranking |
| `engram_get` | Read a document or chunk by path or ID |
| `engram_index` | Index a file or directory |
| `engram_export` | Export memories to markdown |
| `engram_persona` | Read or set the persona file |
| `engram_remember` | Explicitly store a fact (core/project/note) |
| `engram_forget` | Deprecate a KB entry with reason and timestamp |
| `engram_review` | Approve or reject pending facts |

## Configuration

```json
{
  "plugins": {
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/engram.db",
          "contextThreshold": 0.75,
          "freshTailCount": 32,
          "incrementalMaxDepth": -1,
          "leafChunkTokens": 20000,
          "leafTargetTokens": 2000,
          "condensedTargetTokens": 1500,
          "summarizationModel": "ollama-openai/kimi-k2.5:cloud",
          "kbEnabled": true,
          "kbAutoIndexOnStart": true,
          "kbAutoIndexSessions": true,
          "kbCollections": [
            {
              "name": "obsidian",
              "path": "/path/to/obsidian/vault",
              "pattern": "**/*.md",
              "description": "Obsidian vault"
            },
            {
              "name": "workspace-memory",
              "path": "~/.openclaw/workspace/memory",
              "pattern": "**/*.md",
              "description": "Claire workspace memory files"
            }
          ],
          "recallEnabled": true,
          "recallMaxResults": 3,
          "recallMinScore": 0.55,
          "recallMaxTokens": 80,
          "recallPrependMaxTokens": 80,
          "embedEnabled": true,
          "embedApiUrl": "http://192.168.0.11:11434/v1/embeddings",
          "embedApiModel": "nomic-embed-text:latest",
          "maxMessageContentBytes": 32768,
          "pruneSummarizedMessages": true,
          "pruneMinAgeDays": 90,
          "compactionMaxDepth": 3,
          "dbSizeWarningMb": 2000,
          "summaryQualityThreshold": 50
        }
      }
    },
    "slots": {
      "contextEngine": "engram"
    }
  }
}
```

All paths default relative to `OPENCLAW_STATE_DIR` (falls back to `~/.openclaw`).

### Key Config Explained

| Key | Default | Purpose |
|-----|---------|---------|
| `contextThreshold` | 0.75 | Fraction of context window that triggers compaction |
| `freshTailCount` | 32 | Recent messages protected from compaction |
| `leafTargetTokens` | 2000 | Target token count for leaf summaries |
| `condensedTargetTokens` | 1500 | Target token count for condensed summaries |
| `recallMinScore` | 0.55 | Minimum relevance score for recall injection |
| `recallMaxResults` | 3 | Maximum number of recall results per turn |
| `recallMaxTokens` | 80 | Maximum tokens for appended recall block |
| `recallPrependMaxTokens` | 80 | Maximum tokens for prepended recall block |
| `maxMessageContentBytes` | 32768 | Cap stored message content at 32KB |
| `pruneSummarizedMessages` | true | Prune raw messages once summarized |
| `pruneMinAgeDays` | 90 | Don't prune messages younger than 90 days |
| `compactionMaxDepth` | 3 | Condense summaries up to depth 3 |
| `dbSizeWarningMb` | 2000 | Warn if DB exceeds this size |
| `summaryQualityThreshold` | 50 | Minimum quality score for summaries |

When `summarizationProvider` and `summarizationModel` are omitted, Engram uses the active OpenClaw runtime defaults. If runtime subagents are unavailable or the summarizer call fails, compaction falls back to the built-in deterministic extractive summarizer.

## Storage Layout

```
~/.openclaw/
├── engram.db              # Main SQLite database
├── engram-persona.md       # Always-injected persona file
└── engram-export.md        # Markdown export of persona and facts
```

### Database Schema

| Area | Tables | Purpose |
|------|--------|---------|
| Transcript | `conversations`, `messages`, `message_parts` | Raw conversation storage |
| Compaction DAG | `summaries`, `summary_messages`, `summary_parents`, `context_items` | Multi-level summary hierarchy |
| Knowledge Base | `kb_collections`, `kb_documents`, `kb_chunks`, `kb_embeddings` | Indexed documents and chunks |
| Durable Memory | `kb_facts`, `kb_conflicts` | Approved facts and conflict surfacing |
| Continuity | `session_end_artifacts` | Goals, decisions, open questions between sessions |

## Installation

```bash
# From local archive
openclaw plugins install /path/to/engram-0.1.0.tgz

# Or build from source
git clone https://github.com/NZF-JDWang/openclaw-engram.git
cd openclaw-engram
npm install
npm run build
cp dist/index.js ~/.openclaw/extensions/engram/dist/index.js
```

Then add to `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "engram"
    }
  }
}
```

Engram replaces the `contextEngine` slot — any existing context engine (lossless-claw) must be disabled or removed.

## Migration from Existing Systems

Engram can import data from lossless-claw and qmd:

```bash
/engram migrate          # Auto-detect and import from LCM/QMD
/engram migrate --dry-run  # Preview without writing
```

Legacy data is preserved — migration copies, doesn't move. After verifying everything works, the old systems can be safely removed.

## Performance

- **DB size**: stabilizes at 400-600 MB with proper pruning; configurable warning at 2 GB
- **Recall latency**: ~100-200ms per turn for KB + fact search
- **Compaction**: inline on `afterTurn`, with extractive fallback that always succeeds
- **Search**: BM25 + FTS5 for lexical, optional vector reranking for semantic

## Development

```bash
npm install          # Install dependencies
npm run build        # Build with esbuild
npm test             # Run test suite
npm run typecheck    # Type checking
```

## License

Private — © 2026 JD Wang