import { describe, expect, it } from 'vitest';

import { isPreset } from '../contracts';
import { createBuiltinPresets } from './builtin';

describe('builtin presets', () => {
  it('are all structurally valid presets', () => {
    for (const preset of createBuiltinPresets()) {
      expect(isPreset(preset)).toBe(true);
    }
  });

  it('have unique names', () => {
    const names = createBuiltinPresets().map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers the encoders called out in the brief', () => {
    const byEncoder = new Map(createBuiltinPresets().map((p) => [p.side.encoderId, p]));
    expect(byEncoder.has('avif')).toBe(true);
    expect(byEncoder.has('oxipng')).toBe(true);
    expect(byEncoder.has('mozjpeg')).toBe(true);
    expect(byEncoder.has('jxl')).toBe(true);
  });

  it('enables resize on the "email photo" preset', () => {
    const email = createBuiltinPresets().find((p) => p.name.startsWith('Email photo'));
    expect(email).toBeDefined();
    expect(email!.side.processorState.resize.enabled).toBe(true);
    expect(email!.side.processorState.resize.width).toBe(1600);
  });

  it('marks the JXL archival preset lossless', () => {
    const archival = createBuiltinPresets().find((p) => p.name.startsWith('JXL archival'));
    expect(archival).toBeDefined();
    if (archival && archival.side.encoderId === 'jxl') {
      expect(archival.side.encoderOptions.lossless).toBe(true);
    }
  });

  it('returns fresh objects on every call — no shared mutable state', () => {
    const first = createBuiltinPresets();
    const second = createBuiltinPresets();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.side).not.toBe(second[0]?.side);

    // Mutating one call's output must not leak into the other.
    const firstOptions = first[0]!.side.encoderOptions as Record<string, unknown>;
    firstOptions['quality'] = -1;
    const secondOptions = second[0]!.side.encoderOptions as Record<string, unknown>;
    expect(secondOptions['quality']).not.toBe(-1);
  });
});
