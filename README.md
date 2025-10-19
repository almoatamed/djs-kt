
# djs-kt — Dynamic JSON manager (cluster + Redis + distributed locks)

Lightweight library to manage and mutate JSON state across a Node.js clustered process tree.
It supports in-memory, JSON-file, and Redis-backed sources. When used with Redis it also
provides a simple distributed locking primitive so worker processes can coordinate safe updates.

This README documents the public API exported from the package root (`index.ts`) and shows
extensive usage examples for single-process, cluster-worker, file-backed, and Redis-backed setups.

Package name: `djs-kt` — this repository is published (or intended to be published) to npm under the name `djs-kt`.

## What this library provides

- `createDynamicJsonManager(redisClient?)` — factory that returns a manager able to create ThreadedJson instances
- `ThreadedJson` — an object representing a JSON document that exposes safe async methods (`get`, `set`, `push`, `pop`, `splice`, `batch`, ...)
- `DistributedLock` — a small helper class that wraps a Redis client to acquire/release locks across processes
- `lockMethod` — helper to wrap methods with a lock (serializes calls)
- `rs` — recursive selector helper used internally and exported for convenience

All exports are available from the package root. Example:

```ts
import djs from 'djs-kt' // or from package root when published
const { makeDJSManager, lockMethod, DistributedLock, rs } = djs
```

## Install

This repository is TypeScript-based. To use in your project either build the package or import the source directly.

Example setup (quick):

1. Install the `djs-kt` package from npm (or bun):
 

```bash
# using npm
npm install djs-kt

# or using bun
bun add djs-kt
```

1. Use TypeScript or compile to JS and import `djs-kt` in your project.

## Core concepts and types

 - Source types supported by `createDynamicJsonManager.makeDynamicJson`:
   - `inMemory`: ephemeral, lives only in the primary process
   - `jsonFile`: persisted on disk (primary process writes file)
   - `redis`: persisted in Redis and coordinates worker operations via the cluster + Redis locks

Important cluster-safety note:

- This library is safe to use across a Node.js clustered process tree. In the supported persistent modes
 (`jsonFile` and `redis`) the primary process is the authority that performs writes and serializes updates.
 Worker processes communicate with the primary via IPC and their update requests are applied by the primary under
 the library's locking strategy. That means persistent state is safe across the cluster even when using `jsonFile` or `inMemory` —
 provided the deployment runs a single primary for that document (the normal Node.js cluster model).

- For multi-host or multi-primary deployments you should use a centralized backing (Redis) which provides a single
 source of truth and supports distributed locking across machines. `jsonFile` mode is cluster-safe when the cluster
 runs on a single machine and the primary process has exclusive write responsibility; it is not a substitute for a
 distributed coordination system across multiple separate hosts unless the file storage is on a shared filesystem and
 you provide an external coordination layer.

If you're unsure which mode to choose: use `redis` for production multi-host deployments and `jsonFile` for simple
single-host setups where the primary will be the only process writing the file.

 - `ThreadedJson` (partial API):
   - `get(selector)`
   - `set(selector, key, value)`
   - `push(selector, value)`
   - `unshift(selector, value)`
   - `pop(selector)`
   - `shift(selector)`
   - `splice(selector, startIndex, deleteCount)`
   - `removeItemFromArray(selector, item, key?)`
   - `updateItemInArray(selector, item, updatedItem, key?)`
   - `batch(queries)`
   - `updateJsonFromProvided(newContent)`

The `selector` values are either a string or `string[]` and use the exported `rs` helper for recursive selection.

## Quick examples

The examples below assume the exports come from the package root (`index.ts`).

### 1) In-memory manager (single process)

```ts
import { makeDJSManager } from 'djs-kt'

async function main() {
 const manager = makeDJSManager() // no redis client => in-memory + file sources supported

 const doc = await manager.makeDynamicJson<{ users: any[] }>({
  source: { type: 'inMemory', uniqueIdentifier: 'users-doc' },
  initialContent: { users: [] }
 })

 await doc.push(['users'], { id: 1, name: 'Alice' })
 const list = await doc.get(['users'])
 console.log(list)
}
 
main()

```

Notes: in-memory mode is ideal for single-process apps or when the primary process holds the authoritative state.

### 2) File-backed manager (primary process writes file)

```ts
import { makeDJSManager } from 'djs-kt'

async function fileExample() {
  const manager = makeDJSManager()
  const doc = await manager.makeDynamicJson<{ counter: number }>({
    source: { type: 'jsonFile', fileFullPath: './data/counter.json' },
    initialContent: { counter: 0 }
  })

  await doc.set([], 'counter', 42)
  console.log(await doc.get([]))
}

fileExample()
```
 
### 3) Redis-backed manager with distributed locks (cluster-safe)

This mode requires a Redis client instance compatible with methods `get`, `set`, and basic string operations.
```ts
import cluster from 'cluster'
import { createClient } from 'redis' // or ioredis
import { createDynamicJsonManager } from 'djs-kt'

async function start() {
 const redis = createClient()
 await redis.connect()
 const manager = createDynamicJsonManager(redis as any)
 // primary creates the authoritative document
 const doc = await manager.makeDynamicJson({
  source: { type: 'redis', uniqueIdentifier: 'app:state' },
  initialContent: { items: [] }
 })
}

start().catch(console.error)
```
 
When Redis mode is used, the library will attempt to acquire a distributed lock (via the `DistributedLock` helper)
inside the primary before making changes. Worker processes send requests to the primary which applies changes.

## Using lockMethod directly

`lockMethod` is exported so you can wrap arbitrary async functions and ensure they execute under a named lock. This is useful
for serializing updates that must not run concurrently across processes.

Example (conceptual):

```ts
import { lockMethod } from 'djs-kt'

// Suppose you have an async function that mutates shared state
async function incrementCounter(doc, delta) {
 const current = await doc.get(['counter'])
 await doc.set([], 'counter', (current || 0) + delta)
}

// Wrap it with lockMethod to ensure serialization across calls
const lockedIncrement = lockMethod(incrementCounter, { lockName: 'counter-lock', lockTimeout: 5000 })

// Now calling lockedIncrement(...) will run the function under the named lock
await lockedIncrement(doc, 1)
```

## Transactions

The library exposes a `transaction` helper on the ThreadedJson instance used in some setups to run a series of
operations as a single logical step on the primary. The primary applies the transaction under the library's locking
strategy so concurrent updates are serialized. This is particularly useful for updating counters or performing read-update-write
sequences safely.

The example below is adapted from `test.ts` in this repository and demonstrates using `transaction` in a cluster where
the primary hosts the authoritative state and workers send requests.

```ts
// test.ts (example usage)
import cluster from 'cluster';
import { createDynamicJsonManager as makeDJSManager } from 'djs-kt';

const NUM_WORKERS = 3;
const UNIQUE_ID = 'mem:counter';

if (cluster.isPrimary) {
  (async () => {
    const manager = makeDJSManager();
    const doc = await manager.makeDynamicJson({
      source: { type: 'inMemory', uniqueIdentifier: UNIQUE_ID },
      initialContent: { counter: 0 },
    });

    // spawn workers
    for (let i = 0; i < NUM_WORKERS; i++) cluster.fork({ WORKER_INDEX: String(i + 1) });

    // run two transactions sequentially on the primary
    await doc.transaction(async (d) => {
      console.log('Primary transaction: increment');
      const s = await d.get(['counter']);
      await d.set([], 'counter', (s as number) + 1);
    });

    await doc.transaction(async (d) => {
      console.log('Primary transaction: increment');
      const s = await d.get(['counter']);
      await d.set([], 'counter', (s as number) + 1);
    });

    // wait and print final counter
    setTimeout(async () => {
      console.log('final:', await doc.get(['counter']));
      process.exit(0);
    }, 3000);
  })();
} else {
  (async () => {
    const manager = makeDJSManager();
    const doc = await manager.makeDynamicJson({
      source: { type: 'inMemory', uniqueIdentifier: UNIQUE_ID },
      initialContent: { counter: 0 },
    });

    const inc = async (d: number) => {
      await doc.transaction(async (d) => {
        console.log('Worker transaction increment on worker', cluster.worker?.id);
        const s = await d.get(['counter']);
        await d.set([], 'counter', (s as number) + d);
      });
    };

    for (let i = 0; i < 3; i++) {
      await inc(1);
    }
    process.exit(0);
  })();
}
```

 
Notes:
- `transaction` is a convenience that runs the provided async callback on the primary under the lock. Inside the callback
  you receive a ThreadedJson-like object to `get`, `set`, and run other mutation helpers.
- Worker processes can call `transaction` too — their calls are forwarded to the primary which executes them in order.
- If you need multi-host distributed transactions (across machines), use the `redis` mode and ensure your `DistributedLock`
  / Redis locking strategy is configured appropriately.

Details:

- `lockMethod(fn, options)` returns a wrapped function with the same signature as `fn`.
- `options.lockName` is used as the unique lock identifier across processes.
- `options.lockTimeout` (ms) controls how long the lock will be held before timing out.

Internally the library integrates the `lockMethod` behavior with `createDynamicJsonManager` so many of the ThreadedJson operations are already used under locks.

## Example: worker <-> primary message flow (cluster)

1. Primary creates the ThreadedJson instance and listens for queries from worker processes.
2. Worker obtains a lightweight proxy object; method calls like `push()` are sent to the primary process using `process.send`.
3. Primary runs the requested update under a lock (if Redis mode or when `lockMethod` is used) and then replies with the result.

If you want to implement custom messages or add more hooks, examine the `makeDynamicJson` implementation in `djs.ts` to see how queries are structured and how the primary listens to `process.on('message')`.

## Error handling and edge cases

- If Redis mode is requested but no Redis client was passed when creating the manager, `makeDynamicJson` will throw.
- The locking code tries to acquire a lock inside the primary; if lock acquisition fails an error is thrown.
- Worker-to-primary communication relies on Node's `cluster` IPC (`process.send`); ensure your environment supports it.

## Troubleshooting

- If updates appear lost in `jsonFile` mode, ensure the primary process has write permission to the target path.
- If workers hang while waiting for results, confirm the process message handlers are active in the primary (no unhandled errors causing the listener to terminate).

## Contributing

If you add new mutation operations, keep the same pattern used in `djs.ts`: primary performs the mutation under `lockMethod` and workers send queries through cluster IPC.
