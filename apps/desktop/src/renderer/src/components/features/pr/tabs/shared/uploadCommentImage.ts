import { invoke } from '../../../../../api';

/**
 * 把粘贴 / 选取的图片 File 经 IPC 上传到当前 PR 的附件存储，返回可插入正文的 markdown
 * （上传失败 / 平台不支持回 null）。评论回复 / 新建评论 / 草稿编辑共用，避免各处重复实现。
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
