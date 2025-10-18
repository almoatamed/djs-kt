import { createDynamicJsonManager } from "./djs";
import { DistributedLock } from "./redis/lock";
import { lockMethod } from "./utils/lockMethod";
import { rs, recursiveSelect } from "./utils/recursiveSelect";

const makeDJSManager = createDynamicJsonManager;
export { makeDJSManager, recursiveSelect, rs, lockMethod, DistributedLock };

export default {
    makeDJSManager: createDynamicJsonManager,
    recursiveSelect: rs,
    rs,
    lockMethod,
    DistributedLock,
};
