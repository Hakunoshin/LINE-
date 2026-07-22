-- 投稿末尾の導線(CTA)の種類を記録する。'dm'(DM誘導) または 'comment'(コメント誘導)。
-- どちらが伸びるかを自動でA/Bテスト(ε-greedy)するために使う。
ALTER TABLE threads_post_metrics ADD COLUMN cta_type TEXT;
