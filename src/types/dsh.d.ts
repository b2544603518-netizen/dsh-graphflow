/** Minimal compile-time declarations for DSH packages supplied by the Host at runtime. */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    readonly agent?: any
    readonly logger?: { warn(message: string): void; error(message: string): void }
    effect<T>(factory: () => T | Promise<T>, label?: string): T
    on(name: string, listener: (...args: any[]) => any): () => void
    emit(name: string, ...args: any[]): void
    get(name: string): unknown
    provide(name: string, value: unknown): void
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}
