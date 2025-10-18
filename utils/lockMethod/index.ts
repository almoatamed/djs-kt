import AsyncLock from "async-lock";

type ArgumentsExtract<T> = T extends (...args: infer R) => any ? R : never;
type UnwrapPromise<P> = P extends Promise<infer R> ? R : P;

const lock = new AsyncLock({ maxExecutionTime: 5e3 });


export const lockMethod = function <T extends (...args: any[]) => any>(
    method: T,
    {
        lockName,
        lockTimeout = 1e4,
    }: {
        lockName: string;
        lockTimeout?: number;
    }
): (...args: ArgumentsExtract<T>) => Promise<UnwrapPromise<ReturnType<T>>> {
    const originalMethod = method;
    return async function (...args: any[]) {
        return new Promise(async (resolve, reject) => {
            try {
                await lock.acquire(
                    lockName,
                    async () => {
                        try {
                            return resolve(await originalMethod(...args));
                        } catch (error: any) {
                            reject(error);
                        }
                    },
                    {
                        timeout: lockTimeout,
                    }
                );
            } catch (error: any) {
                reject(error);
            }
        });
    };
};
