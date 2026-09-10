/**
 * Minimal ambient declarations for the bundled @deepseek-ai runtime deps.
 *
 * The real packages are bundled at build time via tsdown aliases (see
 * tsdown.config.ts) — these declarations only cover the surface this plugin
 * touches, keeping the source decoupled from the harness checkout.
 */

declare module '@deepseek-ai/schemastery' {
  interface SchemaApi {
    (value: unknown): unknown
    readonly '~standard': unknown
    default(value: unknown): SchemaApi
    min(value: number): SchemaApi
    max(value: number): SchemaApi
    description(text: string): SchemaApi
    required(): SchemaApi
  }
  const Schema: {
    object(fields: Record<string, unknown>): SchemaApi
    string(): SchemaApi
    number(): SchemaApi
    boolean(): SchemaApi
    union(values: readonly unknown[]): SchemaApi
    array(inner: unknown): SchemaApi
  }
  export default Schema
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool<T extends object>(definition: T): T
}

// react is a module-table external in the browser bundle (never installed
// beside the plugin); the client half only uses these members.
declare module 'react' {
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown
  export function useState<S>(
    initial: S | (() => S),
  ): [S, (next: S | ((previous: S) => S)) => void]
  export function useRef<T>(initial: T): { current: T }
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

declare module '*.md' {
  const text: string
  export default text
}
