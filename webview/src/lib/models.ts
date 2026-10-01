export function filterModels(models: string[], query: string, names?: Map<string, string>): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return models;
  }
  return models.filter((model) => model.toLowerCase().includes(trimmed) || names?.get(model)?.toLowerCase().includes(trimmed));
}
