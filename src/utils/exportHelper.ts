import JSZip from 'jszip';
import { chooseBestLegalDocTemplate, getLegalDocTemplate, getLegalDocTemplates, type LegalDocTemplate } from './legalTemplateService.ts';

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

function replaceDocxBodyXml(documentXml: string, content: string): string {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(documentXml, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length) throw new Error('ملف وورد القالب يحتوي على XML غير صالح.');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = xmlDoc.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new Error('لم يتم العثور على متن المستند داخل قالب وورد.');
  const originalParagraphs = Array.from(body.getElementsByTagNameNS(ns, 'p'));
  const nonEmpty = originalParagraphs.filter((p) => textOfParagraph(p));
  const headingTemplate = nonEmpty.find((p) => isHeadingLike(textOfParagraph(p), p)) || nonEmpty[0];
  const bodyTemplate = nonEmpty.find((p) => !isHeadingLike(textOfParagraph(p), p)) || nonEmpty[0] || originalParagraphs[0];
  if (!bodyTemplate && !headingTemplate) throw new Error('القالب لا يحتوي على فقرة يمكن استخدامها للتنسيق.');

  const directChildren = Array.from(body.children);
  const sectPr = directChildren.find((child) => child.localName === 'sectPr') || null;
  // Preserve a clearly identifiable leading lawyer letterhead that lives in the
  // document body, but stop before case-specific matter is reached.
  const frontMatter: Element[] = [];
  for (const child of directChildren) {
    if (child === sectPr) continue;
    const childText = (child.textContent || '').replace(/\s+/g, ' ').trim();
    if (/محكمة|رقم الدعوى|مذكرة بدفاع|المدعي|المدعى عليه|الوقائع|أسباب الطعن|الطلبات الختامية|جلسة/.test(childText)) break;
    if (childText && /مكتب|للمحاماة|المحامي|المحاماة|تليفون|هاتف|استشارات قانونية/.test(childText)) {
      frontMatter.push(child.cloneNode(true) as Element);
      if (frontMatter.length >= 5) break;
    }
  }
  while (body.firstChild) body.removeChild(body.firstChild);
  frontMatter.forEach((element) => body.appendChild(element));
  const paragraphs = content.replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of paragraphs) {
    const line = rawLine.trim();
    const styleSource = (isGeneratedHeading(line) && headingTemplate) ? headingTemplate : bodyTemplate;
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
    body.appendChild(paragraph);
  }
  if (sectPr) body.appendChild(sectPr);
  const serialized = new XMLSerializer().serializeToString(xmlDoc);
  if (!serialized || !serialized.includes('<w:document')) throw new Error('تعذر إعادة إنشاء محتوى مستند وورد.');
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
        template = chooseBestLegalDocTemplate(templates, {
          courtType: options.courtType,
          workType: options.workType,
          facts: options.facts,
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
      window.alert('تعذر تطبيق القالب الأصلي بالكامل. سيتم تنزيل نسخة وورد بالتنسيق العام بدلًا من إيقاف التصدير.');
    }
  }
  downloadBlob(makeGenericWordBlob(content), `${cleanTitle}_${Date.now()}.doc`);
}
