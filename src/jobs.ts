// Threadsに投稿する求人の「公開URL」リスト(circusのjobDetailPublicToken付きURL)。
// ここに載せたURLの求人が投稿対象になる。追加・削除はこの配列を編集して再デプロイするだけ。
//
// 外部ページで管理したい場合は、環境変数 JOBS_PAGE_URL にそのページのURLを設定すると、
// そのページ本文からcircusの公開URLを自動抽出して使う(この配列より優先)。
export const DEFAULT_JOB_URLS: string[] = [
  "https://circus-job.com/search/279468?jobDetailPublicToken=141317d2-acbc-4151-adbd-e750cee485b3",
  "https://circus-job.com/search/430740?jobDetailPublicToken=cda076e8-a8d8-4932-a7fa-3407ecca79ad",
  "https://circus-job.com/search/381562?jobDetailPublicToken=440213af-05df-45e8-a019-b6361da78367",
  "https://circus-job.com/search/453645?jobDetailPublicToken=5362942d-7286-4b6e-a638-0c3877eced55",
  "https://circus-job.com/search/287222?jobDetailPublicToken=a1b00bdd-3512-437d-b180-d324fbf148c6",
  "https://circus-job.com/search/437787?jobDetailPublicToken=2009e049-737e-4587-88a0-68c37577a9df",
  "https://circus-job.com/search/422708?jobDetailPublicToken=6ac84f51-5370-46e8-8af9-f2856b8ca208",
  "https://circus-job.com/search/449993?jobDetailPublicToken=11a63ce4-8390-4cbe-9fa7-7f01a2675833",
  "https://circus-job.com/search/416872?jobDetailPublicToken=af66d6b4-00a8-4cc7-8f22-aa4227462f2c",
  "https://circus-job.com/search/66133?jobDetailPublicToken=6f8bd68c-a205-4042-a500-cbb2a0fd1337",
  "https://circus-job.com/search/387456?jobDetailPublicToken=55e74952-aa21-41db-aa25-cd7203d53b23",
  "https://circus-job.com/search/232389?jobDetailPublicToken=9d376ed1-6017-4ade-aa9b-c90f7b4e3ab1",
  "https://circus-job.com/search/15355?jobDetailPublicToken=1692cb03-197b-4332-a442-d490602a5154",
];
