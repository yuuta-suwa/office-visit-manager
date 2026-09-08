# 来社管理アプリ MVP

Visual Studio Codeで開発できる、Next.js + Supabase の社内向け来社管理アプリです。

## 実装済み機能

- メールアドレス + パスワードのログイン
- マスターキー保持者 / 一般スタッフの権限分離
- マスターのみ開場・閉場操作
- 開閉ログ保存（日時・担当者）
- 最新開閉状態のRealtime反映
- 今日の来社予定を時間順表示
- 今日〜1ヶ月先の来社予約
- 同一スタッフの時間重複予約をDB側で拒否
- 自分の予約の編集・削除
- マスター向けユーザー権限管理
- PostgreSQL RLSによるDB権限管理
- 主要書込みのDB側レート制限
- Auth側の認証レート制限を利用

## セキュリティ方針

- 公開サインアップはアプリに実装していません。
- スタッフアカウントは管理者が Supabase Dashboard → Authentication → Users から作成します。
- 初期ロールは必ず `staff`。ブラウザから `master` を自己申告できません。
- 一般スタッフが見られる他人の予約は「今日の来社予定」のみです。自分の予約は今後分を閲覧できます。
- 開閉、予約書込み、ロール変更はDB関数を通し、RLSと権限チェックをDB側でも実施します。

## 1. 必要環境

- Node.js 20.9以上
- Visual Studio Code
- Supabaseプロジェクト

## 2. VS Codeで起動準備

ターミナルでプロジェクトフォルダを開きます。

```bash
npm install
cp .env.example .env.local
```

`.env.local` にSupabaseの値を設定します。

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxx
```

## 3. DBを作成

Supabase Dashboard → SQL Editor で `supabase/schema.sql` を全て実行します。

## 4. Supabase Auth設定

Authentication → Providers / Sign In で以下を確認します。

- Email + Password: ON
- Public Sign Up: OFF（社内限定運用）
- Password minimum length: 8以上。可能なら12以上
- Leaked Password Protection: 利用可能ならON
- Rate Limits: 有効

## 5. スタッフアカウントを作成

Supabase Dashboard → Authentication → Users → Add user からスタッフを追加します。

DBトリガーにより `profiles` に一般スタッフとして自動登録されます。

## 6. 最初のマスターを1名設定

Authentication → Users で対象ユーザーUUIDを確認し、SQL Editorで1回だけ実行します。

```sql
update public.profiles
set role = 'master'
where id = 'ここにユーザーUUID';
```

その後はアプリ右上の「ユーザー管理」から、14名のマスターキー保持者を設定できます。

## 7. 起動

```bash
npm run dev
```

`http://localhost:3000` を開きます。

## 8. HTTPS

ローカル開発だけはHTTPです。本番はVercel等のHTTPS対応環境へデプロイしてください。Supabase APIはHTTPS URLを利用します。

## 9. 予約重複の定義

現状は「同一スタッフ本人の時間帯重複」を禁止しています。複数スタッフが同じ時刻に来社することは許可します。

## 10. 本番運用前の次フェーズ推奨

- マスターキー保持者へMFA必須化
- 管理画面からのユーザー招待
- 退職者のアカウント無効化フロー
- CSP等のSecurity Headers強化
- 監査ログCSV出力 / 長期保管
- 自動バックアップと復旧テスト
- E2Eテスト
- Redis / Edgeベースの追加Rate Limit
- エラー監視（Sentry等）
