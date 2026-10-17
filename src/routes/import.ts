// ================================================================
// Import Routes — bulk import for skills, plugins, knowledge
//
// Two formats are supported:
//   1. Multi-file ZIP (skills / plugins / knowledge)
//   2. Single skill markdown named skill-<类型>-<编号>.md (skills only)
// ================================================================

import { Router, Response } from 'express';
import { upload } from '../middleware/upload';
import { importFromZip, importSkillFromMarkdown } from '../services/importService';
import { adminAuth, AuthRequest } from '../middleware/auth';

const router = Router();

function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

function isZipFile(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

/**
 * POST /api/admin/import/upload?type=skills|plugins|knowledge
 *
 * - type=skills accepts EITHER:
 *   - a ZIP file with the bulk skill structure, OR
 *   - a single markdown file named `skill-<类型>-<编号>.md`
 *     where 类型=Skill 的 category, 编号=正整数.
 * - type=plugins|knowledge still expects a ZIP.
 */
router.post('/upload', adminAuth, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传 ZIP 或单个 skill-<类型>-<编号>.md 文件' });
    }

    const type = String(req.query.type || '').toLowerCase();
    if (!['skills', 'plugins', 'knowledge'].includes(type)) {
      return res.status(400).json({ error: '类型参数无效，支持: skills, plugins, knowledge' });
    }

    const originalName = req.file.originalname || '';
    const buffer = req.file.buffer;

    let result;
    if (type === 'skills' && isMarkdownFile(originalName)) {
      result = await importSkillFromMarkdown(originalName, buffer);
    } else if (isZipFile(originalName) || req.file.mimetype === 'application/zip') {
      result = await importFromZip(buffer, type as 'skills' | 'plugins' | 'knowledge');
    } else {
      return res.status(400).json({
        error: `type=${type} 需要 ZIP 文件；skills 也可传单个 skill-<类型>-<编号>.md`,
      });
    }

    res.json({
      success: result.success,
      failed: result.failed,
      errors: result.errors,
      summary: result.summary,
    });
  } catch (err: any) {
    console.error('[Import] Error:', err);
    res.status(500).json({ error: err.message || '导入失败' });
  }
});

export default router;

