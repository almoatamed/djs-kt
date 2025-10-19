import cluster, { Worker } from "cluster";
import fs from "fs/promises";
import { lockMethod as LockMethod } from "./utils/lockMethod/index.js";
import { DistributedLock } from "./redis/lock/index.js";
import type Redis from "ioredis";
import { rs } from "./utils/recursiveSelect/index.js";

export type FilePath = string;

export type JsonUpdateQuery = {
    type: "push" | "unshift" | "set";
    selector: string | Array<string>;
    key: string;
    value: any;
};

export type ThreadedJson<JSONDefinition extends any> = {
    get: (selector: string | string[]) => Promise<any>;
    transaction: (
        cb: (context: ThreadedJson<JSONDefinition>) => Promise<void> | void,
        timeout?: number
    ) => Promise<void>;
    set: (selector: string | string[] | null | undefined, key: string, value: any) => Promise<boolean>;
    push: (arraySelector: string | string[], value: any) => Promise<boolean>;
    removeItemFromArray: (arraySelector: string | string[], item: any, key?: string | number) => Promise<boolean>;
    updateItemInArray: (
        arraySelector: string | string[] | null | undefined,
        item: any,
        updatedItem: any,
        key?: string | number
    ) => Promise<boolean>;
    pop: (selector: string | string[]) => Promise<any>;
    shift: (selector: string | string[]) => Promise<any>;
    splice: (arraySelector: string | string[], startIndex: number, count: number) => Promise<false | any[]>;
    unshift: (selector: string | string[], value: any) => Promise<boolean>;
    batch: (queries: Array<JsonUpdateQuery>) => Promise<void>;
    updateJsonFromProvided: (newContent: JSONDefinition) => Promise<void>;
};

let queryCounter = 0;
const generateQueryId = () => {
    return Math.floor(Math.random() * 10e10);
};

export type JSONSourceFilePath = `${string}.json`;

type SourceType =
    | {
          type: "jsonFile";
          fileFullPath: string;
      }
    | {
          type: "redis";
          uniqueIdentifier: string;
      }
    | {
          type: "inMemory";
          uniqueIdentifier: string;
      };

export const createDynamicJsonManager = (redisClient?: Redis) => {
    let redisLock: DistributedLock | undefined = undefined;
    if (redisClient) {
        redisLock = new DistributedLock(redisClient);
    }
    return {
        makeDynamicJson: async function makeDynamicJson<JSONDefinition extends any>({
            source,
            initialContent,
        }: {
            source: typeof redisClient extends undefined
                ?
                      | {
                            type: "jsonFile";
                            fileFullPath: string;
                        }
                      | {
                            type: "inMemory";
                            uniqueIdentifier: string;
                        }
                : SourceType;
            initialContent?: JSONDefinition;
        }): Promise<ThreadedJson<JSONDefinition>> {
            const uniqueEventId = `${source.type == "jsonFile" ? source.fileFullPath : source.uniqueIdentifier}`;

            if (source.type == "redis" && (!redisClient || !redisLock)) {
                throw new Error(
                    "this manager cannot create redis based client with redis connection, please create new manager with a valid redis connection"
                );
            }

            if (cluster.isPrimary) {
                let redisLockId: string | null = null;

                const lockRedis = async (force = false): Promise<boolean> => {
                    if (((!lockId && !primaryLock.locked) || force) && source.type == "redis" && cluster.isPrimary) {
                        redisLockId = await redisLock!.acquire(uniqueEventId);
                        return !!redisLockId;
                    } else {
                        return true;
                    }
                };
                const releaseRedis = async (force = false) => {
                    if (((!lockId && !primaryLock.locked) || force) && source.type == "redis" && redisLockId) {
                        await redisLock!.release(uniqueEventId, redisLockId);
                    }
                };

                const lockMethod = <T extends (...args: any[]) => any>(method: T) => {
                    return LockMethod(
                        (async (...args: any) => {
                            const locked = await lockRedis();
                            if (locked) {
                                try {
                                    method(...args);
                                } catch (error) {
                                    console.error(error);
                                    throw error;
                                } finally {
                                    releaseRedis();
                                }
                            } else {
                                throw new Error("failed to acquire redis Lock " + uniqueEventId);
                            }
                        }) as T,
                        {
                            lockName: uniqueEventId,
                            lockTimeout: 5e3,
                        }
                    );
                };
                let inMemory = initialContent || {};
                if (source.type == "jsonFile") {
                    if (initialContent && !(await fs.exists(source.fileFullPath))) {
                        await fs.writeFile(source.fileFullPath, JSON.stringify(initialContent));
                    }
                } else if (source.type == "redis") {
                    if (initialContent) {
                        const existingContent = await redisClient!.get(uniqueEventId);
                        if (!existingContent) {
                            const locked = await lockRedis();
                            if (locked) {
                                try {
                                    await redisClient!.set(uniqueEventId, JSON.stringify(initialContent));
                                } catch (error) {
                                    console.error(error);
                                    throw error;
                                } finally {
                                    releaseRedis();
                                }
                            }
                        }
                    }
                }

                const getAllData = async () => {
                    let result: any;
                    if (source.type == "inMemory") {
                        result = inMemory;
                    } else if (source.type == "redis" && redisClient) {
                        result = await redisClient.get(uniqueEventId);
                    } else if (source.type === "jsonFile" && (await fs.exists(source.fileFullPath))) {
                        result = JSON.parse(await fs.readFile(source.fileFullPath, "utf-8"));
                    } else {
                        result = {};
                    }
                    return result || {};
                };

                const update = async (updatedData: JSONDefinition) => {
                    if (source.type == "jsonFile") {
                        await fs.writeFile(source.fileFullPath, JSON.stringify(updatedData));
                    } else if (redisClient && source.type == "redis") {
                        await redisClient.set(uniqueEventId, JSON.stringify(updatedData));
                    }
                };

                const setDirect = lockMethod(async function (
                    selector: string | string[] | null | undefined,
                    key: string,
                    value: any
                ) {
                    const data = await getAllData();
                    const target = rs(selector || [], data);
                    if (typeof target == "object" && !!target && !Array.isArray(target)) {
                        target[key] = value;
                        update(data);
                        return true;
                    } else {
                        return false;
                    }
                });

                const pushDirect = lockMethod(async function (selector: string | string[], value: any) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        target.push(value);
                        update(data);
                        return true;
                    } else {
                        return false;
                    }
                });

                const unshiftDirect = lockMethod(async function (selector, value) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        target.unshift(value);
                        update(data);
                        return true;
                    } else {
                        return false;
                    }
                });

                const removeItemFromArrayDirect = lockMethod(async function (selector, item, key) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        const itemIndex = target.findIndex((ti) => {
                            if (!key) {
                                return ti == item;
                            } else {
                                return ti[key] == item[key];
                            }
                        });
                        if (itemIndex != -1) {
                            target.splice(itemIndex, 1);
                            update(data);
                            return true;
                        } else {
                            return false;
                        }
                    } else {
                        return false;
                    }
                });

                const updateItemInArrayDirect = lockMethod(async function (selector, item, updatedItem, key) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        const itemIndex = target.findIndex((ti) => {
                            if (!key) {
                                return ti === item;
                            } else {
                                return ti[key] == item[key];
                            }
                        });
                        if (itemIndex != -1) {
                            if (typeof target[itemIndex] == "object") {
                                target[itemIndex] = {
                                    ...target[itemIndex],
                                    updatedItem,
                                };
                            } else {
                                target[itemIndex] = updatedItem;
                            }
                            update(data);
                            return true;
                        } else {
                            return false;
                        }
                    } else {
                        return false;
                    }
                });

                const batchSetDirect = lockMethod(async function (queries: Array<JsonUpdateQuery>) {
                    const data = await getAllData();
                    for (const query of queries) {
                        if (query.type == "push") {
                            const target = rs(query.selector, data);
                            if (typeof target === "object" && Array.isArray(target)) {
                                target.push(query.value);
                            }
                        } else if (query.type == "set") {
                            const target = rs(query.selector, data);
                            if (typeof target === "object" && !!target) {
                                target[query.key] = query.value;
                            }
                        } else if (query.type == "unshift") {
                            const target = rs(query.selector, data);
                            if (typeof target === "object" && Array.isArray(target)) {
                                target.unshift(query.value);
                            }
                        }
                    }
                    update(data);
                });

                const spliceDirect = lockMethod(async function (selector, startIndex: number, deleteCount: number) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        const result = target.splice(startIndex, deleteCount);
                        update(data);
                        return result;
                    } else {
                        return false;
                    }
                });

                const popDirect = lockMethod(async function (selector) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        const result = target.pop();
                        update(data);
                        return result;
                    } else {
                        return false;
                    }
                });

                const shiftDirect = lockMethod(async function (selector) {
                    const data = await getAllData();
                    const target = rs(selector, data);
                    if (typeof target === "object" && Array.isArray(target)) {
                        const result = target.shift();
                        update(data);
                        return result;
                    } else {
                        return false;
                    }
                });
                const updateJsonFromProvided = lockMethod(async (newData: JSONDefinition) => {
                    return await update(newData);
                });

                let lockId: number | null = null;

                const sleep = (period: number) => {
                    return new Promise<void>((resolve) => {
                        setTimeout(resolve, period);
                    });
                };

                const waitForLockIdRelease = async () => {
                    let tryCount = 0;
                    while (tryCount < 30) {
                        tryCount++;
                        await sleep(30 + Math.random() * 71);
                        if (!lockId) {
                            return;
                        }
                    }
                    throw new Error("Could not acquire lock for operation");
                };

                let lockIdTimer: NodeJS.Timeout | number | undefined = undefined;
                const setLockId = (timeout: number) => {
                    lockId = generateQueryId();
                    lockIdTimer = setTimeout(() => {
                        clearLockId();
                        console.error("Lock expired and released with timeout");
                    }, timeout);
                };
                const clearLockId = () => {
                    console.log("clearing lock", lockId);
                    clearTimeout(lockIdTimer);
                    lockId = null;
                };

                const primaryLock = {
                    locked: false,
                    timeout: null as null | number | undefined | NodeJS.Timeout,
                };

                const waitForPrimaryLockIdRelease = async () => {
                    let tryCount = 0;
                    while (tryCount < 30) {
                        tryCount++;
                        await sleep(30 + Math.random() * 71);
                        if (!primaryLock.locked) {
                            console.log("primary released!");
                            return;
                        }
                    }
                    throw new Error("Could not acquire primary lock for operation");
                };

                const setPrimaryLockId = (timeout: number) => {
                    primaryLock.locked = true;
                    console.log("locking the primary");
                    primaryLock.timeout = setTimeout(() => {
                        clearPrimaryLockId();
                        console.error("Primary Lock expired and released with timeout");
                    }, timeout);
                };
                const clearPrimaryLockId = () => {
                    primaryLock.locked = false;
                    clearTimeout(primaryLock.timeout || undefined);
                    console.log("Releasing the primary");
                };

                const transaction = async (
                    cb: (context: ThreadedJson<JSONDefinition>) => void | Promise<void>,
                    timeout: number = 5e3
                ) => {
                    if (lockId) {
                        await waitForLockIdRelease();
                    }
                    await lockRedis(true);

                    setPrimaryLockId(timeout);
                    try {
                        await cb(result);
                    } catch (error) {
                        console.error(error);
                        throw error;
                    } finally {
                        releaseRedis(true);
                        clearPrimaryLockId();
                    }
                };

                const createWorkerListener = async (worker: Worker) => {
                    return async (msg: any) => {
                        try {
                            if (msg.request == uniqueEventId) {
                                // console.log("Got message from worker on primary", msg);

                                if (primaryLock.locked) {
                                    console.log(worker.id, "worker listener waiting for primary to release");
                                    await waitForPrimaryLockIdRelease();
                                }
                                if (lockId && msg.query?.lockId != lockId) {
                                    console.log("Waiting for a lock id to release", lockId);
                                    await waitForLockIdRelease();
                                }
                                if (msg.query?.type == "lock") {
                                    if (lockId && msg.query?.lockId == lockId) {
                                        throw new Error("you already have a lock");
                                    }
                                    setLockId(msg.query.timeout || 5e3);
                                    console.log("Sending lock id", lockId, "to worker", worker.id);
                                    worker.send({
                                        queryId: msg.queryId,
                                        result: lockId,
                                        finished: true,
                                    });
                                } else if (msg.query?.type == "release") {
                                    if (!lockId) {
                                        throw new Error("there is no lock to release");
                                    }

                                    if (msg.query?.lockId != lockId) {
                                        throw new Error("you do not own this lock");
                                    }

                                    clearLockId();

                                    worker.send({
                                        queryId: msg.queryId,
                                        result: true,
                                        finished: true,
                                    });
                                } else {
                                    if (msg.query?.type == "get") {
                                        worker.send({
                                            queryId: msg.queryId,
                                            result: rs(msg.query.selector, await getAllData()),
                                            finished: true,
                                        });
                                    } else {
                                        let result;
                                        if (msg.query?.type == "set") {
                                            result = await setDirect(
                                                msg.query.selector,
                                                msg.query.key,
                                                msg.query.value
                                            );
                                        } else if (msg.query?.type == "push") {
                                            result = await pushDirect(msg.query.selector, msg.query.value);
                                        } else if (msg.query?.type == "unshift") {
                                            result = await unshiftDirect(msg.query.selector, msg.query.value);
                                        } else if (msg.query?.type == "arraySet") {
                                            result = await batchSetDirect(msg.query.queries);
                                        } else if (msg.query?.type == "pop") {
                                            result = await popDirect(msg.query.selector);
                                        } else if (msg.query?.type == "removeItemFromArray") {
                                            result = await removeItemFromArrayDirect(
                                                msg.query.selector,
                                                msg.query.item,
                                                msg.query.key
                                            );
                                        } else if (msg.query?.type == "updateItemInArray") {
                                            result = await updateItemInArrayDirect(
                                                msg.query.selector,
                                                msg.query.item,
                                                msg.query.updatedItem,
                                                msg.query.key
                                            );
                                        } else if (msg.query?.type == "shift") {
                                            result = await shiftDirect(msg.query.selector);
                                        } else if (msg.query?.type == "splice") {
                                            result = await spliceDirect(
                                                msg.query.selector,
                                                msg.query.startIndex,
                                                msg.query.deleteCount
                                            );
                                        } else if (msg.query?.type == "updateJsonFromProvided") {
                                            result = await updateJsonFromProvided(msg.query.data);
                                        }

                                        worker.send({
                                            queryId: msg.queryId,
                                            finished: true,
                                            result,
                                        });
                                    }
                                }
                            }
                        } catch (error: any) {
                            worker.send({
                                queryId: msg.queryId,
                                finished: true,
                                error,
                            });
                        }
                    };
                };

                const workersListeners: import("cluster").Worker[] = [];

                cluster.on("fork", async (worker) => {
                    if (worker) {
                        workersListeners.push(worker.on("message", await createWorkerListener(worker)));
                    }
                });

                const result: ThreadedJson<JSONDefinition> = {
                    batch: batchSetDirect,
                    transaction,
                    get: async (selector) => {
                        return rs(selector, await getAllData());
                    },
                    shift: shiftDirect,
                    push: pushDirect,
                    removeItemFromArray: removeItemFromArrayDirect,
                    set: setDirect,
                    pop: popDirect,
                    splice: spliceDirect,
                    unshift: unshiftDirect,
                    updateItemInArray: updateItemInArrayDirect,
                    updateJsonFromProvided,
                };
                return result;
            } else {
                let lockId: number | undefined = undefined;

                const lock = async function (timeout: number = 5e3) {
                    const query = {
                        type: "lock",
                        timeout,
                    };
                    lockId = await sendQuery(query);
                    console.log("got lock id for lock", lockId);
                    console.log("returning");
                    return lockId;
                };

                const release = async function () {
                    const query = {
                        type: "release",
                    };
                    return await sendQuery(query);
                };
                const transaction = async (
                    cb: (context: ThreadedJson<JSONDefinition>) => void | Promise<void>,
                    timeout: number = 5e3
                ) => {
                    console.log("Acquiring lock", cluster.worker?.id);
                    const lockId = await lock(timeout);
                    console.log("Locked with id", lockId, "on worker", cluster.worker?.id);
                    try {
                        await cb(result);
                    } catch (error) {
                        console.error(error);
                    } finally {
                        await release();
                    }
                    console.log("transaction finished for", cluster.worker?.id);
                };

                const get = async function (selector: string | string[]) {
                    const query = {
                        type: "get",
                        selector: selector,
                    };
                    return await sendQuery(query);
                };

                const updateItemInArray = async function (
                    selector: string | string[] | null | undefined,
                    item: any,
                    updatedItem: any,
                    key?: string | number
                ) {
                    const query = {
                        type: "updateItemInArray",
                        selector,
                        item,
                        updatedItem,
                        key,
                    };
                    return await sendQuery(query);
                };

                const updateJsonFromProvided = async function (newJson: JSONDefinition) {
                    const query = {
                        type: "data",
                        data: newJson,
                    };
                    return await sendQuery(query);
                };

                const removeItemFromArray = async function (
                    selector: string | string[],
                    item: any,
                    key?: string | number
                ) {
                    const query = {
                        type: "removeItemFromArray",
                        selector,
                        item,
                        key,
                    };
                    return await sendQuery(query);
                };

                const splice = async function (
                    selector: string | string[] | null | undefined,
                    startIndex: number,
                    deleteCount: number
                ) {
                    const query = {
                        type: "splice",
                        selector: selector,
                        startIndex,
                        deleteCount,
                    };
                    return await sendQuery(query);
                };

                const pop = async function (selector: string | string[] | null | undefined) {
                    const query = {
                        type: "pop",
                        selector: selector,
                    };
                    return await sendQuery(query);
                };

                const shift = async function (selector: string | string[]) {
                    const query = {
                        type: "shift",
                        selector: selector,
                    };
                    return await sendQuery(query);
                };

                const set = async function (selector: string | string[] | null | undefined, key: string, value: any) {
                    const query = {
                        type: "set",
                        selector: selector,
                        key: key,
                        value: value,
                    };
                    return await sendQuery(query);
                };

                const push = async function (selector: string | string[] | null | undefined, value: any) {
                    const query = {
                        type: "push",
                        selector: selector,
                        value: value,
                    };
                    return await sendQuery(query);
                };

                const unshift = async function (selector: string | string[] | null | undefined, value: any) {
                    const query = {
                        type: "unshift",
                        selector: selector,
                        value: value,
                    };
                    return await sendQuery(query);
                };

                const batch = async function (queries: Array<JsonUpdateQuery>) {
                    const query = {
                        type: "arraySet",
                        queries: queries,
                    };
                    return await sendQuery(query);
                };

                const sendQuery = async (query: any) => {
                    const queryId = generateQueryId();
                    process.send?.({
                        request: uniqueEventId,
                        queryId: queryId,
                        query: { ...query, lockId },
                    });
                    return await waitForQueryNumber(queryId);
                };

                const waitForQueryNumber = (queryId: number) => {
                    return new Promise<any>((resolve, reject) => {
                        const handler = (msg: any) => {
                            if (msg.queryId == queryId && msg.finished) {
                                if (msg.error) {
                                    reject(msg.error);
                                } else {
                                    resolve(msg.result);
                                }
                                clearTimeout(timer);
                                process.removeListener("message", handler);
                            }
                        };
                        process.addListener("message", handler);
                        const timer = setTimeout(() => {
                            try {
                                process.removeListener("message", handler);
                            } catch (error: any) {
                                console.log(error);
                            } finally {
                                reject("Timeout");
                            }
                        }, 5e3);
                    });
                };

                const result = {
                    batch,
                    get,
                    pop,
                    shift,
                    push,

                    removeItemFromArray,
                    set,
                    splice,
                    unshift,
                    updateItemInArray,
                    transaction,
                    updateJsonFromProvided,
                } satisfies ThreadedJson<JSONDefinition>;

                return result;
            }
        },
    };
};
