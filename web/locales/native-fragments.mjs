// First-party renderer and review fragments. Never applied to raw protocol fields.
export default Object.freeze({
"en": Object.freeze({
  "protocol.fragment.negation": "not",
  "protocol.fragment.intact": "intact",
  "protocol.clearing.approval": "Exact ERC-721 token approval to the pinned escrow only. No approval-for-all. Opening needs a separate review and send.",
  "protocol.clearing.condition": "The contract re-reads the projection atomically. A late qualifying admission prevents refund, including after the deadline.",
  "protocol.clearing.unavailable": "Unavailable or no admitted entry; never inferred from the position.",
  "protocol.clearing.holder": "Returned by escrow observation; independent from the position."
}),
"zh-Hans": Object.freeze({
  "protocol.fragment.negation": "未",
  "protocol.fragment.intact": "完整",
  "protocol.clearing.approval": "仅向固定托管合约授权这一 ERC-721 代币，不作全部授权。开启交易需单独审阅并发送。",
  "protocol.clearing.condition": "合约会原子性地重新读取投影。即使截止时间已过，迟到但符合条件的记录接纳也会阻止退款。",
  "protocol.clearing.unavailable": "不可用或没有已接纳记录；绝不从持仓推断。",
  "protocol.clearing.holder": "由托管观察返回；独立于持仓。"
}),
"zh-Hant": Object.freeze({
  "protocol.fragment.negation": "未",
  "protocol.fragment.intact": "完整",
  "protocol.clearing.approval": "僅向固定託管合約授權這一 ERC-721 代幣，不作全部授權。開啟交易需單獨審閱並傳送。",
  "protocol.clearing.condition": "合約會原子性地重新讀取投影。即使截止時間已過，遲到但符合條件的記錄接納也會阻止退款。",
  "protocol.clearing.unavailable": "無法使用或沒有已接納記錄；絕不從持倉推斷。",
  "protocol.clearing.holder": "由託管觀察回傳；獨立於持倉。"
}),
"fr": Object.freeze({
  "protocol.fragment.negation": "non",
  "protocol.fragment.intact": "intacte",
  "protocol.clearing.approval": "Approbation du seul jeton ERC-721 exact au séquestre fixé. Aucune approbation globale. L’ouverture exige un examen et un envoi distincts.",
  "protocol.clearing.condition": "Le contrat relit la projection atomiquement. Une admission admissible tardive empêche le remboursement, même après l’échéance.",
  "protocol.clearing.unavailable": "Indisponible ou aucune entrée admise ; jamais déduit de la position.",
  "protocol.clearing.holder": "Renvoyé par l’observation du séquestre ; indépendant de la position."
}),
"es": Object.freeze({
  "protocol.fragment.negation": "no",
  "protocol.fragment.intact": "íntegra",
  "protocol.clearing.approval": "Aprobación únicamente del token ERC-721 exacto al depósito fijado. Sin aprobación global. Abrir requiere una revisión y un envío separados.",
  "protocol.clearing.condition": "El contrato relee la proyección atómicamente. Una admisión tardía que cumpla las condiciones impide el reembolso, incluso después del plazo.",
  "protocol.clearing.unavailable": "No disponible o sin entrada admitida; nunca se infiere de la posición.",
  "protocol.clearing.holder": "Devuelto por la observación del depósito; independiente de la posición."
}),
"ja": Object.freeze({
  "protocol.fragment.negation": "非",
  "protocol.fragment.intact": "整合",
  "protocol.clearing.approval": "固定されたエスクローに対する、この ERC-721 トークンだけの承認です。一括承認はしません。開始には別途確認と送信が必要です。",
  "protocol.clearing.condition": "コントラクトは投影を原子的に再読取します。条件を満たす接納が遅れて到着すると、期限後でも返金を阻止します。",
  "protocol.clearing.unavailable": "利用不可または受け入れ済み記録なし。保有ポジションから推測しません。",
  "protocol.clearing.holder": "エスクロー観察の返り値です。保有ポジションとは独立しています。"
})
});
