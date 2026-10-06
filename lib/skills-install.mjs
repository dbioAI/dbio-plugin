/**
 * lib/skills-install.mjs — tự ghi skill vào ~/.claude/skills từ AI Playbook (MỘT nguồn = playbook online `skill-<tên>`).
 * Quy ước playbook: có mục "SKILL.md" chứa MỘT khối ``` (markdown) là TOÀN BỘ tệp SKILL.md (kể cả frontmatter).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SKILLS = [{ name: 'pm', slug: 'skill-pm' }, { name: 'staff', slug: 'skill-staff' }, { name: 'khoi-dong', slug: 'skill-khoi-dong' }];

/** Lấy khối ``` đầu tiên (có thể ```markdown) trong text; null nếu không có. Hỗ trợ khối lồng bằng hàng rào dài hơn (````). */
export function extractSkill(text) {
  const m = /^(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*$/m.exec(String(text ?? ''));
  return m ? `${m[2].trimEnd()}\n` : null;
}

/** Skill hợp lệ? Phải có frontmatter name + description. */
export function validSkill(md) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(String(md ?? ''));
  return !!fm && /^name:\s*\S/m.test(fm[1]) && /^description:\s*\S/m.test(fm[1]);
}

export const skillsDir = (home = homedir()) => join(home, '.claude', 'skills');

/** Ghi skill; trả đường dẫn. */
export function writeSkill(name, md, home = homedir()) {
  const dir = join(skillsDir(home), name);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'SKILL.md');
  writeFileSync(f, md);
  return f;
}
