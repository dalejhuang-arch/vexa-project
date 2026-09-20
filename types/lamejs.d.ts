// types/lamejs.d.ts
// lamejs ships no types; this is the minimal surface lib/mp3Encode.ts uses.
declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  const _default: { Mp3Encoder: typeof Mp3Encoder };
  export default _default;
}