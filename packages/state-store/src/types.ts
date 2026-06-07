/**
 * 持久化 KV 抽象。一期 JSON 文件实现；满足触发条件后可换 SQLite。
 *
 * key 形如 `connections` / `runs/pr-42/run-xyz`，由调用者保证结构。
 * 实现负责把 key 映射到具体存储位置，并保证写入原子性。
 */
export interface StateStore {
  /** 读取 key；不存在返回 null。 */
  read<T>(key: string): Promise<T | null>;
  /** 原子写入 key；自动创建父目录。 */
  write<T>(key: string, data: T): Promise<void>;
  /** 删除 key；不存在 nop。 */
  delete(key: string): Promise<void>;
  /** 列出指定前缀下的所有 key（不含值）。 */
  list(prefix: string): AsyncIterable<string>;
  /**
   * 递归删除某个前缀下的整个目录树（含子目录 / 非 .json 文件 / 整个 prefix dir 自身）。
   * 用于 PR 退场时一次清掉 `prs/<hash>/` 下的 meta / comments / runs 等所有子文件。
   * 不存在 / 不是目录都 no-op。
   */
  deleteDir(prefix: string): Promise<void>;
}
