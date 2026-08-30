-- 除外詳細(抽出時に各段階でどれだけ除外されたかの内訳)
--
-- ユーザー要望: 既存ツール(公式)の「除外詳細」表示に相当する機能。
-- まず、現在抽出パイプラインで実際に実行されている除外
-- (タイトル重複・active重複・翻訳後タイトル重複・危険単語)の件数を
-- 記録・可視化する第一段階として追加する(一括編集設定の除外条件を
-- 抽出時に自動適用する機能は別途対応予定)。
ALTER TABLE extractions
  ADD COLUMN IF NOT EXISTS exclusion_summary JSONB;

COMMENT ON COLUMN extractions.exclusion_summary IS
  '抽出時の除外内訳(件数)。例: {"detail_fetch_count":357,"danger_word_excluded":0,"active_duplicate_excluded":0,"title_duplicate_excluded":12,"translated_duplicate_excluded":0,"completed_count":345}';
