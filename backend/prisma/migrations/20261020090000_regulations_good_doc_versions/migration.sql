-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "isGood" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "linkedGoodDocId" TEXT;

-- CreateTable
CREATE TABLE "regulations" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "articleNo" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_regulations" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "regulationId" TEXT NOT NULL,

    CONSTRAINT "issue_regulations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_doc_versions" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_doc_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_regulations_issueId_regulationId_key" ON "issue_regulations"("issueId", "regulationId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_doc_versions_docId_version_key" ON "knowledge_doc_versions"("docId", "version");

-- AddForeignKey
ALTER TABLE "issue_regulations" ADD CONSTRAINT "issue_regulations_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_regulations" ADD CONSTRAINT "issue_regulations_regulationId_fkey" FOREIGN KEY ("regulationId") REFERENCES "regulations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_doc_versions" ADD CONSTRAINT "knowledge_doc_versions_docId_fkey" FOREIGN KEY ("docId") REFERENCES "knowledge_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 预置法规库（参照《法规库.md》清单，summary 取"关键内容"列；id 固定便于追溯） ──
INSERT INTO "regulations" ("id", "category", "title", "articleNo", "summary", "updatedAt") VALUES
('reg_nl_01', 'national_law', '中华人民共和国安全生产法', NULL, '生产经营单位安全生产职责：落实全员安全生产责任制，保障安全投入，开展隐患排查治理与教育培训', CURRENT_TIMESTAMP),
('reg_nl_02', 'national_law', '中华人民共和国消防法', NULL, '消防安全管理要求：落实消防安全责任制，保障疏散通道畅通，配置消防设施器材并定期检验', CURRENT_TIMESTAMP),
('reg_nl_03', 'national_law', '中华人民共和国职业病防治法', NULL, '职业健康与防护要求：职业病危害因素检测评价、劳动防护用品配备、职业健康监护', CURRENT_TIMESTAMP),
('reg_nl_04', 'national_law', '中华人民共和国刑法修正案（十一）', NULL, '安全事故刑事责任条款：强令违章冒险作业罪、危险作业罪等安全生产相关刑事责任', CURRENT_TIMESTAMP),
('reg_xz_01', 'regulation', '中华人民共和国特种设备安全法', NULL, '特种设备生产、使用、检验检测的安全管理要求，特种设备作业人员持证上岗', CURRENT_TIMESTAMP),
('reg_xz_02', 'regulation', '危险化学品安全管理条例', NULL, '危险化学品生产、储存、使用、经营、运输全流程安全管理要求', CURRENT_TIMESTAMP),
('reg_xz_03', 'regulation', '生产安全事故应急条例', NULL, '生产安全事故应急准备、应急救援队伍与预案演练、事故应急处置要求', CURRENT_TIMESTAMP),
('reg_xz_04', 'regulation', '工贸企业重大事故隐患判定标准', NULL, '工贸企业重大事故隐患判定情形与标准，用于重大隐患的识别与判定', CURRENT_TIMESTAMP),
('reg_gb_01', 'gb_standard', 'GB 18218-2018 危险化学品重大危险源辨识', NULL, '危险化学品重大危险源的辨识指标与判定标准', CURRENT_TIMESTAMP),
('reg_gb_02', 'gb_standard', 'GB/T 33000-2025 大中型企业安全生产标准化管理体系要求', NULL, '安全生产标准化管理体系要求，标准化车间达标依据', CURRENT_TIMESTAMP),
('reg_gb_03', 'gb_standard', 'GB/T 29639-2020 生产经营单位生产安全事故应急预案编制导则', NULL, '生产安全事故应急预案编制标准（综合预案、专项预案、现场处置方案）', CURRENT_TIMESTAMP),
('reg_gb_04', 'gb_standard', 'GB 30756-2014 镍冶炼安全生产规范', NULL, '镍冶炼行业专用安全生产规范，直接适用于镍冶炼各工序安全管理', CURRENT_TIMESTAMP),
('reg_cj_01', 'factory_policy', '镍冶炼厂安全管理一线工作法实施方案', NULL, '"五步"工作法（直接沟通→查看现场→验证措施→解决问题→反馈改进）与5大体系（责任落实、双重预防、宣传培训、监督检查、应急救援）', CURRENT_TIMESTAMP),
('reg_cj_02', 'factory_policy', '职工安全行为规范奖惩实施细则（金川镍钴镍制〔2024〕58号）', NULL, '5级惩戒（批评教育→经济处罚→离岗培训→行政处分→终止劳动关系）与奖励机制，含保命条款、零伤害条款', CURRENT_TIMESTAMP),
('reg_cj_03', 'factory_policy', '镍冶炼厂治本攻坚三年行动方案（2024-2026）', NULL, '三阶段推进：2024隐患攻坚年（存量隐患全消除）、2025强基固本年（双重预防机制建立）、2026效能提升年（体系高效运行）', CURRENT_TIMESTAMP);
