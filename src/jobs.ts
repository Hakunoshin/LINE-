// Threadsに投稿する求人の「公開URL」リスト(circusのjobDetailPublicToken付きURL)。
// ここに載せたURLの求人が投稿対象になる。1社1件・最新優先で管理する(同じ会社は最新URLに差し替え)。
//
// 外部ページで管理したい場合は、環境変数 JOBS_PAGE_URL にそのページのURLを設定すると、
// そのページ本文からcircusの公開URLを自動抽出して使う(この配列より優先)。
export const DEFAULT_JOB_URLS: string[] = [
  // プレミアムウォーター株式会社
  "https://circus-job.com/search/279468?jobDetailPublicToken=cc231df8-2e29-4eda-a225-8ede29cb49c9",
  // 株式会社青山メインランド
  "https://circus-job.com/search/430740?jobDetailPublicToken=cda076e8-a8d8-4932-a7fa-3407ecca79ad",
  // 株式会社水野
  "https://circus-job.com/search/381562?jobDetailPublicToken=440213af-05df-45e8-a019-b6361da78367",
  // 株式会社いーふらん
  "https://circus-job.com/search/453645?jobDetailPublicToken=5362942d-7286-4b6e-a638-0c3877eced55",
  // 株式会社貴瞬
  "https://circus-job.com/search/287222?jobDetailPublicToken=a1b00bdd-3512-437d-b180-d324fbf148c6",
  // 楽天トータルソリューションズ株式会社
  "https://circus-job.com/search/437787?jobDetailPublicToken=2009e049-737e-4587-88a0-68c37577a9df",
  // NOWALL株式会社
  "https://circus-job.com/search/422708?jobDetailPublicToken=6ac84f51-5370-46e8-8af9-f2856b8ca208",
  // 株式会社カドル
  "https://circus-job.com/search/449993?jobDetailPublicToken=11a63ce4-8390-4cbe-9fa7-7f01a2675833",
  // 株式会社GT‐works
  "https://circus-job.com/search/416872?jobDetailPublicToken=af66d6b4-00a8-4cc7-8f22-aa4227462f2c",
  // ディーエムソリューションズ株式会社
  "https://circus-job.com/search/66133?jobDetailPublicToken=6f8bd68c-a205-4042-a500-cbb2a0fd1337",
  // 株式会社コンシェルテック
  "https://circus-job.com/search/387456?jobDetailPublicToken=55e74952-aa21-41db-aa25-cd7203d53b23",
  // 株式会社style
  "https://circus-job.com/search/232389?jobDetailPublicToken=9d376ed1-6017-4ade-aa9b-c90f7b4e3ab1",
  // 国際自動車株式会社
  "https://circus-job.com/search/15355?jobDetailPublicToken=1692cb03-197b-4332-a442-d490602a5154",
  // 株式会社CTF GROUP
  "https://circus-job.com/search/299489?jobDetailPublicToken=eb372883-844e-4a22-a602-014244dd12f7",
  // 株式会社エスコシステムズ
  "https://circus-job.com/search/398138?jobDetailPublicToken=3f9e12e0-2ed2-4773-b42b-5660b1215d02",
  // 株式会社CU
  "https://circus-job.com/search/246310?jobDetailPublicToken=f5b91a6c-6794-407f-a63d-d2aabf4ed7c8",
  // 株式会社IDOM
  "https://circus-job.com/search/319897?jobDetailPublicToken=3d08176b-1033-4d52-a8ca-00e533a6b99b",
  // 株式会社DYMキャリア
  "https://circus-job.com/search/138003?jobDetailPublicToken=ae431299-3dfd-434c-b49d-18defa9403bb",
];
