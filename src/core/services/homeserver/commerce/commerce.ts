import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';

export class CommerceHomeserverService {
  private constructor() {}

  static async fetchJson(url: string): Promise<unknown> {
    return await HomeserverService.request<unknown>({ method: HttpMethod.GET, url });
  }

  static async putJson(url: string, bodyJson: Record<string, unknown>): Promise<void> {
    await HomeserverService.request({ method: HttpMethod.PUT, url, bodyJson });
  }

  static async putMedia(url: string, bytes: Uint8Array): Promise<void> {
    await HomeserverService.putBlob({ url, blob: bytes });
  }

  static async delete(url: string): Promise<void> {
    await HomeserverService.request({ method: HttpMethod.DELETE, url });
  }
}
