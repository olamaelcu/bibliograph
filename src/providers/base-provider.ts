export abstract class BaseBookProvider {
  protected async fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
      const response = await fetch(url, init);
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
