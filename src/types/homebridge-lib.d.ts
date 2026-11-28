// Strict layer: homebridge-lib ships no type definitions, so the part the example uses is
// declared here instead of being used as `any`.
declare module 'homebridge-lib/EveHomeKitTypes' {
  import type { API, Characteristic, Service, WithUUID } from 'homebridge';

  /** An Eve service: a HAP service type that builds itself with no arguments. */
  export type EveService = WithUUID<typeof Service> & (new (displayName?: string, subtype?: string) => Service);

  export class EveHomeKitTypes {
    constructor(api: API);
    readonly Services: Record<string, EveService>;
    readonly Characteristics: Record<string, WithUUID<new () => Characteristic>>;
  }
}
