/**
 * Hand-written types for `heic-decode` (CJS, no bundled types).
 * API verified against node_modules/heic-decode/lib.js v2.1.0.
 */
declare module 'heic-decode' {
  interface HeicDecodeResult {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  interface HeicDecodeInput {
    buffer: Uint8Array;
  }

  function decode(input: HeicDecodeInput): Promise<HeicDecodeResult>;

  namespace decode {
    function all(
      input: HeicDecodeInput,
    ): Promise<Array<{ width: number; height: number; decode(): Promise<HeicDecodeResult> }>>;
  }

  export default decode;
}
