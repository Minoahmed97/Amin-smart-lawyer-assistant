export default function handler(_req: any, res: any) {
  return res.status(403).json({
    ok: false,
    error: 'إدارة الباقات والشحن غير متاحة في النسخة الشخصية.',
  });
}
