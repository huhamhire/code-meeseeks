type Model = { id: string; label: string };

export function resolveCodexModel(models: readonly Model[], preferredId: string) {
  return models.find((model) => model.id === preferredId) ?? latestSol(models) ?? models[0];
}

function latestSol(models: readonly Model[]) {
  const versions = models.flatMap((model) => {
    const match = /^gpt-(\d+(?:\.\d+)*)-sol$/i.exec(model.id);
    return match?.[1] ? [{ model, version: match[1].split('.').map(Number) }] : [];
  });
  return versions.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  })[0]?.model;
}
