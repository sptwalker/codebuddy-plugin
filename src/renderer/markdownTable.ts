/**
 * Markdown 表格通用生成器
 * 生成标准 GFM 表格，兼容 CodeBuddy 聊天窗口渲染
 */

/**
 * 构建 Markdown 表格字符串
 *
 * @param headers  表头数组
 * @param rows     二维数据行数组（每行是一个单元格值数组）
 * @param aligns?  每列对齐方式: 'left' | 'center' | 'right'，默认左对齐
 * @returns 完整的 Markdown 表格字符串（含末尾换行）
 */
export function buildMarkdownTable(
  headers: string[],
  rows: string[][],
  aligns?: ('left' | 'center' | 'right')[]
): string {
  const colCount = headers.length;

  // 确保每行长度一致
  const normalizedRows = rows.map((row) => {
    while (row.length < colCount) row.push('');
    return row;
  });

  // 计算每列最大宽度
  const widths: number[] = headers.map((h, i) => {
    let max = String(h).length;
    for (const row of normalizedRows) {
      max = Math.max(max, String(row[i]).length);
    }
    return max;
  });

  // 对齐符号映射
  const alignChar = (align: string): string => {
    switch (align) {
      case 'center': return ':-:';
      case 'right':  return '-:';
      default:       return '-';
    }
  };

  // 构建分隔行
  const sepRow = widths
    .map((w, i) => {
      const a = aligns?.[i] ? alignChar(aligns[i]) : '-';
      return a.padEnd(w + (a.length > 1 ? 2 : 0), '-');
    })
    .join(' | ');

  // 填充并对齐单元格
  const padCell = (text: string, w: number, align?: string): string => {
    const str = String(text);
    const diff = w - str.length;
    if (diff <= 0) return str;
    switch (align) {
      case 'center': {
        const left = Math.floor(diff / 2);
        const right = diff - left;
        return ' '.repeat(left) + str + ' '.repeat(right);
      }
      case 'right':
        return ' '.repeat(diff) + str;
      default:
        return str + ' '.repeat(diff);
    }
  };

  // 构建表头行
  const headerLine = headers
    .map((h, i) => padCell(h, widths[i], aligns?.[i]))
    .join(' | ');

  // 构建数据行
  const dataLines = normalizedRows.map((row) =>
    row
      .map((cell, i) => padCell(cell, widths[i], aligns?.[i]))
      .join(' | ')
  );

  const lines = [
    `| ${headerLine} |`,
    `| ${sepRow} |`,
    ...dataLines.map((line) => `| ${line} |`),
  ];

  return lines.join('\n') + '\n';
}
