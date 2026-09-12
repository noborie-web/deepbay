-- ユーザー要望: 除外の各機能を公式ツールと同等の2段階(グローバル→
-- 一括編集設定)構成にしたい。売り切れ除外・個別危険Seller除外も、公式の
-- 除外詳細に「(一括編集)」接頭辞付きの項目として表示されているため、
-- 一括編集設定プロファイル側でも有効/無効を切り替えられるようにする。
ALTER TABLE bulk_edit_settings
  ADD COLUMN IF NOT EXISTS sold_out_exclude_enabled BOOLEAN NOT NULL DEFAULT true;
