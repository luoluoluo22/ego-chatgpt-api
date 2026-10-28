/**
 * Base Provider for Web-to-API Bridges
 */
export class BaseProvider {
  constructor(name, displayName = name, options = {}) {
    this.name = name;
    this.displayName = displayName;
    this.options = options;
    this.isReady = false;
    this.initError = null;
    this.log = typeof options.log === "function" ? options.log : (msg) => console.log(`[${this.displayName}] ${msg}`);
  }

  async init() {
    throw new Error(`Provider ${this.name} must implement init()`);
  }

  async ensureReady() {
    throw new Error(`Provider ${this.name} must implement ensureReady()`);
  }

  getModels() {
    return [];
  }

  getHealth() {
    return {
      name: this.name,
      displayName: this.displayName,
      ready: this.isReady,
      error: this.initError
    };
  }

  async close() {
    // Optional cleanup
  }
}
