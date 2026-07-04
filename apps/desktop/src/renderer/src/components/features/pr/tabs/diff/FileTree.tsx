import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Icon } from '@iconify/react';
import type { DiffChangedFile } from '@meebox/ipc';
import { ChevronIcon, ConflictIcon } from '../../../../common';

interface FileTreeProps {
  files: DiffChangedFile[];
  selectedKey: string | null;
  /** path → number of published remote inline comments (with renamed-file oldPath compatibility) */
  commentCountByPath: Map<string, number>;
  /** path → number of local unpublished drafts (pending + edited). Same measure as the PR header "Submit review (N)" */
  draftCountByPath: Map<string, number>;
  /** Set of file paths that would conflict on merge: matched file rows show a triangle warning icon to the left of the status dot. */
  conflictPaths: Set<string>;
  onSelect: (file: DiffChangedFile) => void;
}

interface TreeFile {
  type: 'file';
  name: string;
  path: string;
  file: DiffChangedFile;
}

type FolderAggregateStatus = 'added' | 'modified' | 'deleted' | 'mixed';

interface TreeFolder {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
  /** Status aggregated from all descendant files, used to color the folder name */
  aggregateStatus: FolderAggregateStatus;
}

type TreeNode = TreeFile | TreeFolder;

function fileKey(f: DiffChangedFile): string {
  return `${f.oldPath ?? ''}|${f.path}`;
}

export function FileTree({
  files,
  selectedKey,
  commentCountByPath,
  draftCountByPath,
  conflictPaths,
  onSelect,
}: FileTreeProps) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(files), [files]);
  // All expanded by default. collapsed records the set of collapsed paths (empty by default = all expanded)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="diff-file-tree" role="tree">
      {/* Inner inline-block: width = max(max-content, 100%), stretching all rows to the same width,
          otherwise rows of different lengths each go 100%-vs-max-content, leaving sticky dots at their own row ends,
          misaligned when scrolling */}
      <div className="diff-file-tree-inner">
        {renderChildren(tree.children, 0, {
          selectedKey,
          commentCountByPath,
          draftCountByPath,
          conflictPaths,
          onSelect,
          collapsed,
          toggle,
          t,
        })}
      </div>
    </div>
  );
}

interface RenderCtx {
  selectedKey: string | null;
  commentCountByPath: Map<string, number>;
  draftCountByPath: Map<string, number>;
  conflictPaths: Set<string>;
  onSelect: (file: DiffChangedFile) => void;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  t: TFunction;
}

function renderChildren(nodes: TreeNode[], depth: number, ctx: RenderCtx): ReactElement[] {
  const out: ReactElement[] = [];
  for (const n of nodes) {
    if (n.type === 'folder') {
      const isOpen = !ctx.collapsed.has(n.path);
      out.push(
        <div
          key={`F:${n.path}`}
          className={`tree-row tree-folder folder-status-${n.aggregateStatus}${isOpen ? ' open' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => ctx.toggle(n.path)}
          role="treeitem"
          aria-expanded={isOpen}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              ctx.toggle(n.path);
            }
          }}
        >
          <ChevronIcon className="tree-chevron" />
          <span className="tree-icon">
            <Icon
              icon={
                isOpen ? 'material-icon-theme:folder-base-open' : 'material-icon-theme:folder-base'
              }
              width="16"
              height="16"
            />
          </span>
          <span className="tree-name">{n.name}</span>
        </div>,
      );
      if (isOpen) {
        out.push(...renderChildren(n.children, depth + 1, ctx));
      }
    } else {
      const f = n.file;
      const selected = ctx.selectedKey === fileKey(f);
      const count = ctx.commentCountByPath.get(f.path) ?? 0;
      const draftCount = ctx.draftCountByPath.get(f.path) ?? 0;
      const conflict = ctx.conflictPaths.has(f.path) || (!!f.oldPath && ctx.conflictPaths.has(f.oldPath));
      out.push(
        <div
          key={`f:${n.path}`}
          className={`tree-row tree-file tree-file-${f.status} ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => ctx.onSelect(f)}
          role="treeitem"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              ctx.onSelect(f);
            }
          }}
          title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        >
          <span className="tree-chevron-spacer" aria-hidden="true" />
          <span className="tree-icon">
            <Icon icon={fileIconFor(f.path)} width="16" height="16" />
          </span>
          <span className="tree-name">{n.name}</span>
          <span className="tree-row-right" aria-hidden="false">
            {/* draft chip first / comment chip after: reading order "unpublished → published",
                aligned with the left-to-right order of the PR header "Submit review → Approve/Needs work" */}
            {draftCount > 0 && (
              <span
                className="tree-draft-count"
                title={ctx.t('fileTree.draftCountTitle', { count: draftCount })}
              >
                {draftCount}
              </span>
            )}
            {count > 0 && (
              <span
                className="tree-comment-count"
                title={ctx.t('fileTree.commentCountTitle', { count })}
              >
                {count}
              </span>
            )}
            {conflict && (
              <span
                className="tree-conflict"
                title={ctx.t('fileTree.conflictTitle')}
                aria-label="merge conflict"
              >
                <ConflictIcon size={13} />
              </span>
            )}
            <span
              className={`tree-status diff-file-status file-${f.status}`}
              aria-label={f.status}
            />
          </span>
        </div>,
      );
    }
  }
  return out;
}

function buildTree(files: DiffChangedFile[]): TreeFolder {
  const root: TreeFolder = {
    type: 'folder',
    name: '',
    path: '',
    children: [],
    aggregateStatus: 'modified',
  };
  for (const f of files) {
    const parts = f.path.split('/').filter((p) => p.length > 0);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');
      if (isLast) {
        cur.children.push({ type: 'file', name: part, path: fullPath, file: f });
      } else {
        let folder = cur.children.find(
          (c): c is TreeFolder => c.type === 'folder' && c.name === part,
        );
        if (!folder) {
          folder = {
            type: 'folder',
            name: part,
            path: fullPath,
            children: [],
            aggregateStatus: 'modified',
          };
          cur.children.push(folder);
        }
        cur = folder;
      }
    }
  }
  sortTree(root);
  computeAggregateStatus(root);
  return root;
}

function sortTree(node: TreeFolder): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) {
    if (c.type === 'folder') sortTree(c);
  }
}

/**
 * Recursively compute each folder's aggregate status.
 * Priority: modified/typechange > mixed added+deleted > added/renamed/copied > deleted
 * (aligned with the VS Code file explorer look: a folder with any modification is amber, only pure additions are green)
 */
function computeAggregateStatus(node: TreeFolder): FolderAggregateStatus {
  let hasModified = false;
  let hasAdded = false;
  let hasDeleted = false;
  for (const c of node.children) {
    if (c.type === 'folder') {
      const s = computeAggregateStatus(c);
      if (s === 'modified' || s === 'mixed') hasModified = true;
      else if (s === 'added') hasAdded = true;
      else if (s === 'deleted') hasDeleted = true;
    } else {
      const fs = c.file.status;
      if (fs === 'modified' || fs === 'typechange') hasModified = true;
      else if (fs === 'added' || fs === 'renamed' || fs === 'copied') hasAdded = true;
      else if (fs === 'deleted') hasDeleted = true;
    }
  }
  if (hasModified) node.aggregateStatus = 'modified';
  else if (hasAdded && hasDeleted) node.aggregateStatus = 'mixed';
  else if (hasAdded) node.aggregateStatus = 'added';
  else if (hasDeleted) node.aggregateStatus = 'deleted';
  else node.aggregateStatus = 'modified';
  return node.aggregateStatus;
}

function fileIconFor(filePath: string): string {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  const withPrefix = (name: string): string => `material-icon-theme:${name}`;

  // Match special file names first
  const byBasename: Record<string, string> = {
    dockerfile: 'docker',
    'docker-compose.yml': 'docker',
    'docker-compose.yaml': 'docker',
    'package.json': 'nodejs',
    'package-lock.json': 'nodejs',
    '.gitignore': 'git',
    '.gitattributes': 'git',
    '.gitmodules': 'git',
    'tsconfig.json': 'tsconfig',
    'tsconfig.base.json': 'tsconfig',
    'tsconfig.node.json': 'tsconfig',
    '.eslintrc.json': 'eslint',
    '.eslintrc.js': 'eslint',
    'eslint.config.mjs': 'eslint',
    'eslint.config.js': 'eslint',
    '.prettierrc': 'prettier',
    '.prettierrc.json': 'prettier',
    '.prettierignore': 'prettier',
    'prettier.config.js': 'prettier',
    'readme.md': 'readme',
    license: 'certificate',
    'license.md': 'certificate',
    makefile: 'makefile',
    'vite.config.ts': 'vite',
    'vite.config.js': 'vite',
    'electron.vite.config.ts': 'vite',
    'nx.json': 'nx',
    '.editorconfig': 'editorconfig',
    '.env': 'tune',
    '.env.local': 'tune',
  };
  if (byBasename[base]) return withPrefix(byBasename[base]!);

  const ext = base.includes('.') ? base.split('.').pop()! : '';
  const extMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'react-ts',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'react',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    mdx: 'mdx',
    css: 'css',
    scss: 'sass',
    sass: 'sass',
    less: 'less',
    html: 'html',
    htm: 'html',
    vue: 'vue',
    svelte: 'svelte',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    sh: 'console',
    bash: 'console',
    zsh: 'console',
    fish: 'console',
    ps1: 'powershell',
    sql: 'database',
    xml: 'xml',
    php: 'php',
    rb: 'ruby',
    c: 'c',
    h: 'h',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'hpp',
    cs: 'csharp',
    fs: 'fsharp',
    dart: 'dart',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    r: 'r',
    scala: 'scala',
    groovy: 'groovy',
    sol: 'solidity',
    toml: 'toml',
    ini: 'settings',
    conf: 'settings',
    env: 'tune',
    proto: 'proto',
    graphql: 'graphql',
    gql: 'graphql',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    ico: 'image',
    bmp: 'image',
    svg: 'svg',
    pdf: 'pdf',
    zip: 'zip',
    tar: 'zip',
    gz: 'zip',
    txt: 'document',
    log: 'log',
  };
  return withPrefix(extMap[ext] ?? 'document');
}
