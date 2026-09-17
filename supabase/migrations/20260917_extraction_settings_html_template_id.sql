-- 実データで確認した不具合: 抽出設定の「HTML設定」で「アクティブに設定」を
-- 押すと extraction_settings.html_template_id を保存しようとするが、列が
-- 存在せず失敗していた(=HTMLテンプレートは一度も適用されていなかった)。
ALTER TABLE extraction_settings
  ADD COLUMN IF NOT EXISTS html_template_id uuid REFERENCES html_templates(id) ON DELETE SET NULL;
