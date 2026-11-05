import type { UdfPorts } from "./ports.ts";

/**
 * 运行时端口（CONTRACT §6）：createUdfRuntime 组合根一次注入。
 * handlers 经 getPorts() 读取；多实例共享同一份（单进程语义）。
 */
let active: UdfPorts = {};

export function setPorts(ports: UdfPorts): void {
  active = ports;
}

export function getPorts(): UdfPorts {
  return active;
}
