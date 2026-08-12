# Workflow Engine

## Node types

A workflow is stored as a directed acyclic graph with three node categories:

- `trigger`
- `action`
- `destination`

Current keys:

```text
tiktok.new_video
youtube.new_video
facebook.new_reel

media.download
caption.preserve
caption.strip_source_tags

youtube.short
facebook.reel
```

## Execution model

1. The scheduler loads active workflows.
2. Source calls are cached per trigger type for the current scan cycle.
3. Each workflow compares source IDs with its own `sourceState.seenIds`.
4. New source content is normalized into the shared content library.
5. The workflow is executed in topological order.
6. Every node writes a node result to a run record.
7. Destination failures do not stop sibling destinations.
8. Processing failures stop downstream execution.
9. Failed destination retries target only failed destination nodes.

## Loop protection

Content has a stable platform fingerprint such as:

```text
tiktok:123456789
youtube:abcdEFGhijk
facebook:987654321
```

Each workflow also remembers seen source IDs. A workflow is rejected if its destination platform is the same as its trigger platform.

## Adding another platform

A new platform generally needs:

1. OAuth/account connection service.
2. A source listing function returning normalized content if it can be a trigger.
3. A publishing function if it can be a destination.
4. Catalog entries in `/api/catalog`.
5. `fetchSourceItems()` / `executeNode()` registration in `workflow-engine.js`.

The workflow editor itself does not need to be rewritten.
