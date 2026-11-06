// Hard constraint: tests never touch the network. Any un-injected fetch fails loudly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network access attempted in a test: ${String((input as { url?: string })?.url ?? input)}`);
}) as typeof fetch;
