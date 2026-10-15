/**
 * scripts/lib/cdp.mjs —— 最小 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么自己写而不是装 puppeteer：本项目坚持零依赖，而 Node 24 自带全局 WebSocket，
 * 连接 CDP 所需的全部能力（发命令、收事件、按 sessionId 路由）不到 100 行。
 *
 * 只实现验证脚本真正用到的部分：连接、send、事件监听、evaluate。
 */

/** 一个 CDP 连接（可以是浏览器级，也可以是某个标签页/Worker 级）。 */
export class Cdp {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  /** @param {string} webSocketUrl */
  static async connect(webSocketUrl) {
    const cdp = new Cdp(webSocketUrl);
    await cdp.open();
    return cdp;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      const onError = () => reject(new Error(`无法连接 CDP：${this.url}`));
      this.socket.addEventListener('error', onError, { once: true });
      this.socket.addEventListener(
        'open',
        () => {
          this.socket.removeEventListener('error', onError);
          this.socket.addEventListener('message', (event) => this.dispatch(JSON.parse(event.data)));
          resolve();
        },
        { once: true },
      );
    });
  }

  dispatch(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(`${message.error.message}（${JSON.stringify(message.error)}）`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message);
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{sessionId?: string, timeoutMs?: number}} [options]
   */
  send(method, params = {}, options = {}) {
    const id = (this.nextId += 1);
    const sessionId = options.sessionId;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    const timeoutMs = options.timeoutMs || 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  /** @param {(message: object) => void} listener */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等一个匹配的事件，拿到就撤销监听。 */
  waitForEvent(method, predicate = () => true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.on((message) => {
        if (message.method !== method || !predicate(message.params)) return;
        clearTimeout(timer);
        off();
        resolve(message.params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
    });
  }

  /**
   * 在当前 target 里执行表达式。
   * @param {string} expression
   * @param {{awaitPromise?: boolean, timeoutMs?: number}} [options]
   */
  async evaluate(expression, options = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: true,
        userGesture: true,
      },
      { timeoutMs: options.timeoutMs || 30000 },
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(`页面内异常：${detail || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  /** 在页面里执行一段函数体并把返回值 JSON 化，避免手写转义。 */
  async call(fn, ...args) {
    const source = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
    const value = await this.evaluate(source);
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* 已经关闭 */
    }
  }
}

/** 读取 Chrome 的 /json/list 目标列表。 */
export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`/json/list 返回 ${response.status}`);
  return response.json();
}

/** 轮询直到条件成立。 */
export async function waitUntil(check, { timeoutMs = 15000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? `（最后一次错误：${lastError.message}）` : '';
  throw new Error(`等待${label}超时（${timeoutMs}ms）${suffix}`);
}
