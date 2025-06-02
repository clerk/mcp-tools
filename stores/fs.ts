import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonSerializable =
  | null
  | boolean
  | number
  | string
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

const fsStore: { [state: string]: JsonSerializable } = {};
const root = path.join(os.tmpdir(), "__mcp_demo");

const store = {
  write: (k: string, v: JsonSerializable) => {
    fsStore[k] = v;
    fs.writeFileSync(root, JSON.stringify(fsStore));
  },
  read: (k: string) => {
    if (!fs.existsSync(root)) {
      fs.writeFileSync(root, "{}");
    }
    return JSON.parse(fs.readFileSync(root, "utf8"))[k];
  },
};

export default store;
