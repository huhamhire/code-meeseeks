import { invoke } from '../../../../../api';

/**
 * Upload a pasted / selected image File to the current PR's attachment storage via IPC, returning body-insertable markdown
 * (returns null on upload failure / platform not supported). Shared by comment reply / new comment / draft editing to avoid reimplementing everywhere.
 */
export async function uploadCommentImage(prLocalId: string, file: File): Promise<string | null> {
  const bytes = await file.arrayBuffer();
  const res = await invoke('comments:uploadAttachment', {
    localId: prLocalId,
    fileName: file.name || 'image.png',
    contentType: file.type || 'image/png',
    bytes,
  });
  return res?.markdown ?? null;
}
