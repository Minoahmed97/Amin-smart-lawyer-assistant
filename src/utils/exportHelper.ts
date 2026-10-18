import JSZip from 'jszip';
import { chooseBestLegalDocTemplate, classifyLegalDocument, getLegalDocTemplate, getLegalDocTemplates, type LegalDocTemplate } from './legalTemplateService.ts';

export interface LegalWordExportOptions {
  userId?: string;
  templateMode?: 'auto' | 'manual';
  templateId?: string;
  courtType?: string;
  workType?: string;
  facts?: string;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeGenericWordBlob(content: string): Blob {
  const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paragraphs = content.split(/\n\s*\n/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('');
  const htmlContent = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><title>المستند القضائي</title>
    <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
    <style>@page{size:A4;margin:2.5cm 2.5cm 2.5cm 2.5cm;mso-page-orientation:portrait}body{font-family:'Traditional Arabic','Amiri',Arial,sans-serif;font-size:16pt;direction:rtl;text-align:justify;line-height:1.8;color:#000}p{margin-bottom:12pt;line-height:1.8;text-align:justify}h1,h2,h3{font-family:'Traditional Arabic',Arial,sans-serif;font-weight:bold;text-align:center;color:#000}table{border-collapse:collapse;width:100%;margin-bottom:12pt;direction:rtl}th,td{border:1px solid #333;padding:8pt;text-align:right;font-size:14pt}th{background:#f2f2f2;font-weight:bold}</style></head><body>${paragraphs}</body></html>`;
  return new Blob(['\ufeff', htmlContent], { type: 'application/msword;charset=utf-8' });
}

function textOfParagraph(paragraph: Element): string {
  return Array.from(paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'))
    .map((node) => node.textContent || '').join('').trim();
}

function isHeadingLike(text: string, paragraph: Element): boolean {
  const pPr = paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pPr')[0];
  const style = pPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pStyle')[0]?.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'val') || '';
  const align = pPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'jc')[0]?.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'val') || '';
  const rPr = paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'rPr')[0];
  const bold = !!rPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'b').length;
  return /title|heading|subtitle/i.test(style) || (align === 'center' && bold) || (text.length > 0 && text.length < 65 && /^(الوقائع|الدفاع|الدفوع|أولاً|ثانياً|ثالثاً|الطلبات|بناءً عليه|لذلك|الموضوع|مذكرة|أسباب الطعن|الطلبات الختامية)/.test(text));
}

function isGeneratedHeading(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && trimmed.length < 80 && /^(الموضوع|مذكرة|الوقائع|الدفاع|الدفوع|أولاً|ثانياً|ثالثاً|رابعاً|الطلبات|بناءً عليه|لذلك|أسباب الطعن|الطلبات الختامية|أمام محكمة)/.test(trimmed);
}

function isCaseSpecificText(text: string): boolean {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return /رقم الدعوى|المدعي|المدعى عليه|الخصم|الوقائع|أسباب الطعن|الطلبات الختامية|بناء عليه|بناءً عليه|لذلك|مذكرة بدفاع|صحيفة دعوى|جلسة|موضوع الدعوى|الطاعن|المطعون ضده|المستأنف|المستأنف ضده|ضد\s/.test(value)
    || value.length > 180;
}

function isStaticLetterheadText(text: string): boolean {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  return !!value && !isCaseSpecificText(value)
    && /مكتب|للمحاماة|المحامي|المحاماة|تليفون|هاتف|فاكس|استشارات قانونية|العنوان|طنطا|شارع|ميدان|بسم الله الرحمن الرحيم|إن الحكم إلا لله/i.test(value)
    && value.length < 180;
}

function isLayoutTable(node: Element, ns: string): boolean {
  if (node.localName !== 'tbl') return false;
  const cells = Array.from(node.getElementsByTagNameNS(ns, 'tc'));
  if (cells.length < 2) return false;
  const allText = (node.textContent || '').replace(/\s+/g, ' ').trim();
  return isCaseSpecificText(allText) && /مكتب|للمحاماة|المحامي|تليفون|هاتف|العنوان|طنطا|ميدان|شارع/.test(allText);
}

function makeParagraph(xmlDoc: XMLDocument, ns: string, rawLine: string, styleSource?: Element | null): Element {
  const paragraph = xmlDoc.createElementNS(ns, 'w:p');
  const sourcePPr = styleSource?.getElementsByTagNameNS(ns, 'pPr')[0];
  if (sourcePPr) paragraph.appendChild(sourcePPr.cloneNode(true));
  const run = xmlDoc.createElementNS(ns, 'w:r');
  const sourceRPr = styleSource?.getElementsByTagNameNS(ns, 'rPr')[0];
  if (sourceRPr) run.appendChild(sourceRPr.cloneNode(true));
  const textNode = xmlDoc.createElementNS(ns, 'w:t');
  textNode.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  textNode.textContent = rawLine;
  run.appendChild(textNode);
  paragraph.appendChild(run);
  return paragraph;
}

function replaceCellContent(xmlDoc: XMLDocument, cell: Element, lines: string[], ns: string, headingTemplate: Element | null, bodyTemplate: Element | null): void {
  const cellChildren = Array.from(cell.children);
  const tcPr = cellChildren.find((child) => child.localName === 'tcPr') || null;
  const directParagraphs = Array.from(cell.children).filter((child) => child.localName === 'p');
  const paragraphs = directParagraphs.length ? directParagraphs : Array.from(cell.getElementsByTagNameNS(ns, 'p'));
  const heading = paragraphs.find((p) => isHeadingLike(textOfParagraph(p), p)) || headingTemplate || paragraphs[0] || null;
  const body = paragraphs.find((p) => !isHeadingLike(textOfParagraph(p), p)) || bodyTemplate || paragraphs[0] || heading;
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  if (tcPr) cell.appendChild(tcPr);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    cell.appendChild(makeParagraph(xmlDoc, ns, rawLine, isGeneratedHeading(line) ? heading : body));
  }
}

function replaceDocxBodyXml(documentXml: string, content: string): string {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(documentXml, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length) throw new Error('ملف وورد القالب يحتوي على XML غير صالح.');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = xmlDoc.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new Error('لم يتم العثور على متن المستند داخل قالب وورد.');

  const originalChildren = Array.from(body.children);
  const sectPr = originalChildren.find((child) => child.localName === 'sectPr') || null;
  const contentLines = content.replace(/\r\n?/g, '\n').split('\n');
  const allParagraphs = Array.from(body.getElementsByTagNameNS(ns, 'p'));
  const headingTemplate = allParagraphs.find((p) => isHeadingLike(textOfParagraph(p), p)) || allParagraphs[0] || null;
  const bodyTemplate = allParagraphs.find((p) => !isHeadingLike(textOfParagraph(p), p)) || allParagraphs[0] || headingTemplate;
  const firstContentIndex = originalChildren.findIndex((child) => {
    if (child === sectPr) return false;
    const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
    return isCaseSpecificText(text);
  });

  // If the template uses a two-column/table layout for a side margin, keep the
  // table and its section geometry. Replace the main text cell instead of deleting
  // the table (which would destroy the side margin).
  const layoutTable = originalChildren.find((child) => isLayoutTable(child, ns)) || null;
  if (layoutTable) {
    const cells = Array.from(layoutTable.children)
      .filter((row) => row.localName === 'tr')
      .flatMap((row) => Array.from(row.children).filter((cell) => cell.localName === 'tc'));
    const mainCell = cells.slice().sort((a, b) => {
      const aText = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const bText = (b.textContent || '').replace(/\s+/g, ' ').trim();
      const aScore = (isCaseSpecificText(aText) ? 10000 : 0) + aText.length;
      const bScore = (isCaseSpecificText(bText) ? 10000 : 0) + bText.length;
      return bScore - aScore;
    })[0];
    if (mainCell) {
      replaceCellContent(xmlDoc, mainCell, contentLines, ns, headingTemplate, bodyTemplate);
      // Other cells are retained only when their text is static office/letterhead
      // information. Case-specific text in a sidebar cell is removed.
      for (const cell of cells) {
        if (cell === mainCell) continue;
        const directParagraphs = Array.from(cell.children).filter((child) => child.localName === 'p');
        const staticParagraphs = (directParagraphs.length ? directParagraphs : Array.from(cell.getElementsByTagNameNS(ns, 'p')))
          .filter((paragraph) => isStaticLetterheadText(textOfParagraph(paragraph)));
        const tcPr = Array.from(cell.children).find((child) => child.localName === 'tcPr') || null;
        while (cell.firstChild) cell.removeChild(cell.firstChild);
        if (tcPr) cell.appendChild(tcPr);
        for (const paragraph of staticParagraphs) cell.appendChild(paragraph.cloneNode(true));
        if (!staticParagraphs.length) cell.appendChild(makeParagraph(xmlDoc, ns, '', bodyTemplate));
      }
      // Remove old case-specific body blocks but keep the selected layout table,
      // static letterhead blocks, drawings, and section settings.
      for (const child of originalChildren) {
        if (child === layoutTable || child === sectPr) continue;
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (!isStaticLetterheadText(text) && text.length > 0) child.remove();
      }
      if (sectPr && sectPr.parentNode === body) body.appendChild(sectPr);
      const serialized = new XMLSerializer().serializeToString(xmlDoc);
      if (!serialized || !serialized.includes('document')) throw new Error('تعذر إعادة إنشاء محتوى مستند وورد.');
      return serialized;
    }
  }

  // Standard paragraph-based template: preserve the original static letterhead
  // and all non-case-specific layout objects, then insert only the new text.
  const preservedBefore: Element[] = [];
  const preservedAfter: Element[] = [];
  const insertionIndex = firstContentIndex >= 0 ? firstContentIndex : Math.max(0, originalChildren.findIndex((child) => child === sectPr));
  originalChildren.forEach((child, index) => {
    if (child === sectPr) return;
    const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
    const isStatic = isStaticLetterheadText(text) || (!text && (child.getElementsByTagNameNS(ns, 'drawing').length > 0 || child.getElementsByTagNameNS(ns, 'pict').length > 0));
    if (isStatic) {
      if (index < insertionIndex) preservedBefore.push(child.cloneNode(true) as Element);
      else preservedAfter.push(child.cloneNode(true) as Element);
    }
  });

  while (body.firstChild) body.removeChild(body.firstChild);
  preservedBefore.forEach((child) => body.appendChild(child));
  for (const rawLine of contentLines) {
    const line = rawLine.trim();
    body.appendChild(makeParagraph(xmlDoc, ns, rawLine, isGeneratedHeading(line) ? headingTemplate : bodyTemplate));
  }
  preservedAfter.forEach((child) => body.appendChild(child));
  if (sectPr) body.appendChild(sectPr);

  const serialized = new XMLSerializer().serializeToString(xmlDoc);
  if (!serialized || !serialized.includes('document')) throw new Error('تعذر إعادة إنشاء محتوى مستند وورد.');
  return serialized;
}

async function makeTemplateDocxBlob(content: string, templateBlob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(templateBlob);
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) throw new Error('قالب وورد لا يحتوي على ملف document.xml صالح.');
  const originalXml = await documentEntry.async('string');
  const updatedXml = replaceDocxBodyXml(originalXml, content);
  zip.file('word/document.xml', updatedXml);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** Exports using a stored original .docx template when available; otherwise uses the legacy generic .doc export. */
export async function exportLegalDocToWord(content: string, baseTitle = 'صياغة_قضائية', options: LegalWordExportOptions = {}): Promise<void> {
  if (!content?.trim()) return;
  const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) || 'صياغة_قضائية';
  const userId = options.userId;
  if (userId && options.templateMode !== undefined) {
    try {
      let template: LegalDocTemplate | null = null;
      if (options.templateMode === 'manual' && options.templateId) {
        template = await getLegalDocTemplate(options.templateId, userId);
      } else if (options.templateMode === 'manual' && !options.templateId) {
        window.alert('اختَر قالب وورد من القائمة أولًا، أو غيّر الاختيار إلى التنسيق التلقائي.');
        return;
      } else if (options.templateMode === 'auto') {
        const templates = await getLegalDocTemplates(userId);
        const requestedWorkType = (options.workType || '').trim();
        const genericWorkTypes = new Set(['', '__custom__', 'إنشاء صيغة قانونية', 'مهمة قانونية أخرى', 'صيغة قانونية', 'مستند قضائي عام']);
        const inferredWorkType = genericWorkTypes.has(requestedWorkType)
          ? classifyLegalDocument(cleanTitle, content).workType
          : requestedWorkType;
        template = chooseBestLegalDocTemplate(templates, {
          courtType: options.courtType,
          workType: inferredWorkType,
          facts: [options.facts || '', content].filter(Boolean).join('\n'),
        });
      }
      if (template) {
        const blob = await makeTemplateDocxBlob(content, template.blob);
        downloadBlob(blob, `${cleanTitle}_${Date.now()}.docx`);
        return;
      }
      if (options.templateMode === 'manual' && options.templateId) {
        window.alert('تعذر العثور على القالب المختار. سيتم استخدام تنسيق وورد العام.');
      }
    } catch (error) {
      console.error('Template-based Word export failed:', error);
      window.alert('تعذر تطبيق قالب وورد الأصلي. لم يتم تنزيل مستند بديل حتى لا تفقد التنسيق أو يظهر قالب مختلف. راجع ملف القالب وحاول مرة أخرى.');
      return;
    }
  }
  downloadBlob(makeGenericWordBlob(content), `${cleanTitle}_${Date.now()}.doc`);
}
