/**
 * Shared utility to export legal text as a formatted Microsoft Word document (.doc)
 * with Egyptian judicial formatting (A4, RTL, Traditional Arabic).
 */
export function exportLegalDocToWord(content: string, baseTitle: string = 'صياغة_قضائية') {
  if (!content) return;
  const cleanFileName = `${baseTitle}_${Date.now()}.doc`;
  const htmlContent = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <meta charset='utf-8'>
      <title>المستند القضائي</title>
      <!--[if gte mso 9]>
      <xml>
        <w:WordDocument>
          <w:View>Print</w:View>
          <w:Zoom>100</w:Zoom>
          <w:DoNotOptimizeForBrowser/>
        </w:WordDocument>
      </xml>
      <![endif]-->
      <style>
        @page {
          size: A4;
          margin: 2.5cm 2.5cm 2.5cm 2.5cm;
          mso-page-orientation: portrait;
        }
        body {
          font-family: 'Traditional Arabic', 'Amiri', Arial, sans-serif;
          font-size: 16pt;
          direction: rtl;
          text-align: justify;
          line-height: 1.8;
          color: #000000;
        }
        p {
          margin-bottom: 12pt;
          line-height: 1.8;
          text-align: justify;
        }
        h1, h2, h3 {
          font-family: 'Traditional Arabic', Arial, sans-serif;
          font-weight: bold;
          text-align: center;
          color: #000000;
        }
        table {
          border-collapse: collapse;
          width: 100%;
          margin-bottom: 12pt;
          direction: rtl;
        }
        th, td {
          border: 1px solid #333333;
          padding: 8pt;
          text-align: right;
          font-size: 14pt;
        }
        th {
          background-color: #f2f2f2;
          font-weight: bold;
        }
      </style>
    </head>
    <body>
      ${content.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('')}
    </body>
    </html>
  `;
  const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = cleanFileName;
  a.click();
  URL.revokeObjectURL(url);
}
