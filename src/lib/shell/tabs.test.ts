/**
 * `createTabs` — no DOM needed, a fake `JobEngine` stands in for the state
 * layer (contracts, and this store, must not depend on it).
 */

import { describe, expect, it, vi } from 'vitest';
import type { JobEngine, JobEngineState } from '../contracts';
import { createTabs } from './tabs.svelte';

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

function fakeState(): JobEngineState {
  return {
    loading: false,
    preprocessorState: { rotate: 0 },
    sides: [
      { loading: false, latestSettings: { encoderId: 'identity' } },
      { loading: false, latestSettings: { encoderId: 'identity' } },
    ],
  } as unknown as JobEngineState;
}

function fakeEngine(): JobEngine {
  return {
    state: fakeState(),
    setSource: vi.fn(),
    updateSide: vi.fn(),
    updateProcessor: vi.fn(),
    updatePreprocessor: vi.fn(),
    copySettings: vi.fn(),
    abort: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

function file(name: string, bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

/* -------------------------------------------------------------------------- */
/* open / openMany                                                            */
/* -------------------------------------------------------------------------- */

describe('createTabs — open', () => {
  it('opens a file into a new, active tab', () => {
    const createSession = vi.fn(fakeEngine);
    const tabs = createTabs({ createSession, disposeSession: vi.fn() });

    const id = tabs.open(file('art.jpg'));

    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.activeId).toBe(id);
    expect(tabs.active?.id).toBe(id);
    expect(tabs.active?.file.name).toBe('art.jpg');
    expect(tabs.active?.dirty).toBe(false);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('dedupes by name + size instead of opening a duplicate tab', () => {
    const createSession = vi.fn(fakeEngine);
    const tabs = createTabs({ createSession, disposeSession: vi.fn() });

    const firstId = tabs.open(file('art.jpg', 100));
    tabs.open(file('other.jpg', 50));
    const dupeId = tabs.open(file('art.jpg', 100));

    expect(dupeId).toBe(firstId);
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.activeId).toBe(firstId);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('treats same name + different size as a distinct file', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });

    const a = tabs.open(file('art.jpg', 100));
    const b = tabs.open(file('art.jpg', 200));

    expect(a).not.toBe(b);
    expect(tabs.tabs).toHaveLength(2);
  });

  it('openMany opens every file and activates the first', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });

    const ids = tabs.openMany([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    expect(ids).toHaveLength(3);
    expect(tabs.tabs.map((t) => t.id)).toEqual(ids);
    expect(tabs.activeId).toBe(ids[0]);
  });

  it('openMany on an empty list is a no-op', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const ids = tabs.openMany([]);
    expect(ids).toEqual([]);
    expect(tabs.tabs).toHaveLength(0);
    expect(tabs.activeId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* activate                                                                    */
/* -------------------------------------------------------------------------- */

describe('createTabs — activate', () => {
  it('switches the active tab', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));
    const b = tabs.open(file('b.jpg'));

    tabs.activate(a);
    expect(tabs.activeId).toBe(a);
    expect(tabs.active?.id).toBe(a);
    void b;
  });

  it('ignores an unknown id', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));

    tabs.activate('does-not-exist');
    expect(tabs.activeId).toBe(a);
  });
});

/* -------------------------------------------------------------------------- */
/* close / closeAll                                                           */
/* -------------------------------------------------------------------------- */

describe('createTabs — close', () => {
  it('disposes the session and removes the tab', () => {
    const disposeSession = vi.fn();
    const engine = fakeEngine();
    const tabs = createTabs({ createSession: () => engine, disposeSession });

    const id = tabs.open(file('a.jpg'));
    tabs.close(id);

    expect(disposeSession).toHaveBeenCalledWith(engine);
    expect(tabs.tabs).toHaveLength(0);
    expect(tabs.activeId).toBeNull();
  });

  it('activates the neighbour to the right when closing the active middle tab', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));
    const b = tabs.open(file('b.jpg'));
    const c = tabs.open(file('c.jpg'));
    tabs.activate(b);

    tabs.close(b);

    expect(tabs.tabs.map((t) => t.id)).toEqual([a, c]);
    expect(tabs.activeId).toBe(c);
  });

  it('activates the new last tab when closing the rightmost active tab', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));
    const b = tabs.open(file('b.jpg'));
    tabs.activate(b);

    tabs.close(b);

    expect(tabs.tabs.map((t) => t.id)).toEqual([a]);
    expect(tabs.activeId).toBe(a);
  });

  it('leaves the active tab untouched when closing a background tab', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));
    const b = tabs.open(file('b.jpg'));
    tabs.activate(a);

    tabs.close(b);

    expect(tabs.tabs.map((t) => t.id)).toEqual([a]);
    expect(tabs.activeId).toBe(a);
  });

  it('ignores closing an unknown id', () => {
    const disposeSession = vi.fn();
    const tabs = createTabs({ createSession: fakeEngine, disposeSession });
    const a = tabs.open(file('a.jpg'));

    tabs.close('does-not-exist');

    expect(disposeSession).not.toHaveBeenCalled();
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.activeId).toBe(a);
  });

  it('closeAll disposes every session and clears the strip', () => {
    const disposeSession = vi.fn();
    const tabs = createTabs({ createSession: fakeEngine, disposeSession });
    tabs.open(file('a.jpg'));
    tabs.open(file('b.jpg'));

    tabs.closeAll();

    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(tabs.tabs).toHaveLength(0);
    expect(tabs.activeId).toBeNull();
    expect(tabs.active).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* markDirty                                                                   */
/* -------------------------------------------------------------------------- */

describe('createTabs — markDirty', () => {
  it('flips a tab dirty independently of the others', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    const a = tabs.open(file('a.jpg'));
    const b = tabs.open(file('b.jpg'));

    tabs.markDirty(a, true);

    expect(tabs.tabs.find((t) => t.id === a)?.dirty).toBe(true);
    expect(tabs.tabs.find((t) => t.id === b)?.dirty).toBe(false);

    tabs.markDirty(a, false);
    expect(tabs.tabs.find((t) => t.id === a)?.dirty).toBe(false);
  });

  it('ignores an unknown id', () => {
    const tabs = createTabs({ createSession: fakeEngine, disposeSession: vi.fn() });
    expect(() => tabs.markDirty('does-not-exist', true)).not.toThrow();
  });
});
