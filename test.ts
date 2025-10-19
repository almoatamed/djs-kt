import cluster from "cluster";
import { createDynamicJsonManager as makeDJSManager } from "./djs";

const NUM_WORKERS = 3;
const UNIQUE_ID = "mem:counter";

if (cluster.isPrimary) {
    (async () => {
        const manager = makeDJSManager();
        const doc = await manager.makeDynamicJson({
            source: { type: "inMemory", uniqueIdentifier: UNIQUE_ID },
            initialContent: { counter: 0 },
        });
        for (let i = 0; i < NUM_WORKERS; i++) cluster.fork({ WORKER_INDEX: String(i + 1) });
        await doc.transaction(async (doc) => {
            console.log("Incrementing the counter on primary");
            const s = await doc.get(["counter"]);
            console.log("s", s);
            await doc.set([], "counter", (s as any) + 1);
        });
        await doc.transaction(async (doc) => {
            console.log("Incrementing the counter on primary");
            const s = await doc.get(["counter"]);
            console.log("s", s);
            await doc.set([], "counter", (s as any) + 1);
        });
        // wait 3s and print final counter
        setTimeout(async () => {
            console.log("final:", await doc.get(["counter"]));
            process.exit(0);
        }, 3000);
    })();
} else {
    (async () => {
        const manager = makeDJSManager();
        const doc = await manager.makeDynamicJson({
            source: { type: "inMemory", uniqueIdentifier: UNIQUE_ID },
            initialContent: { counter: 0 },
        });
        // prefer lockMethod if available
        const inc = async (d: number) => {
            await doc.transaction(async (doc) => {
                console.log("Incrementing the counter on worker", cluster.worker?.id);
                const s = await doc.get(["counter"]);
                console.log("s", s)
                await doc.set([], "counter", (s as any) + d);
            });
        };

        // each worker does a few increments
        for (let i = 0; i < 3; i++) {
            console.log(cluster.worker?.id, "inc", i)
            await inc(1);

        }
        process.exit(0);
    })();
}
