# Lot 004 — Prouver une réutilisation sûre des lectures vlCVX

Priorité P2 ; effort M ; risque moyen ; dépend de 003. Préparé le 12 novembre 2026 au commit local `574463d37ff590b8f9d9c44f898b466409b78032`, helper identique au main observé `a9f0778229e230502f9c9fe9bd20bcd4c029a692`.

## But et état actuel

Le run https://github.com/stake-dao/bounties-report/actions/runs/43221832855 effectue 23 contrôles de complétude pendant les claims. `expandDelegateVotes` appelle `getOnChainDelegators` par délégué, pour Curve puis FXN. Chaque appel rescane depuis le déploiement :

```ts
// script/utils/onChainDelegation.ts:41–55
  for (
    let fromBlock = CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH;
    fromBlock <= latestBlock;
    fromBlock += LOGS_CHUNK_SIZE
  ) {
// ... topics[2] = delegateTo, chainId = 1
```

Les utilisateurs ayant un jour délégué sont des candidats ; `getDelegateAtEpoch` décide ensuite qui délègue à l’epoch demandée. Le contrôle exact de complétude et `GaugeVoteHelper.getContributingWeights` protègent l’attribution financière. Les poids de contribution Curve et FXN ne sont pas interchangeables. La source RPC sert aussi aux forks et ne doit pas recevoir de candidats issus de l’explorer mainnet.

## Périmètre et dérive

Ce lot commence par une expérimentation, pas par l’activation d’un cache. Lire `script/utils/onChainDelegation.ts`, `script/shared/effectiveVotes.ts`, `delegationHelper.ts`, les consommateurs de répartition/APR et les vérificateurs. Les seuls livrables durables avant la barrière ci-dessous sont les preuves et la mise à jour de ce plan. Les fixtures et prototypes temporaires restent dans un worktree jetable ; ne pas modifier les données du checkout.

Contrôle : `git diff --stat 574463d37ff590b8f9d9c44f898b466409b78032..HEAD -- script/utils/onChainDelegation.ts script/shared/effectiveVotes.ts script/test/unit/onChainDelegation.test.ts`, puis changements non committés. Inventorier les appels via `rg -n 'getOnChainDelegators|expandDelegateVotes' script --glob '*.ts'`.

## Barrière de conception

Un hash RPC stable ne prouve pas que l’explorer a fini d’indexer les logs du bloc correspondant. Si une réponse vide est mémorisée, puis l’explorer révèle un événement du même bloc plus tard, scanner seulement les nouveaux blocs perd cet événement. Le contrôle de poids d’une seule epoch n’établit pas la complétude de tous les candidats historiques. Ne pas livrer ce mini-indexeur incrémental, même seulement en mémoire, sur la base d’un hash RPC.

La cible reste une réutilisation en mémoire des candidats au sein d’un run, jamais des poids. Mais elle n’est autorisée que sur des entrées de lecture identiques, une source dont l’exhaustivité sur la plage est vérifiée et une identité de réseau isolant mainnet/fork. Étudier d’abord la suppression d’un doublon exact ; une agrégation de tous les délégués n’est une option que si pagination et complétude sont démontrées. Sans ces garanties, conserver les rescans ; les lots 001/003/005 restent utiles et livrables indépendamment de cette optimisation.

## Expérimentation et décision

1. Après 003, mesurer les scans réellement redondants : contrat, délégué, epoch, source, horizon de blocs et durée. Distinguer une requête identique d’un appel devenu différent parce que la tête a avancé. Ne pas appeler « cache hit » une réutilisation d’un état antérieur.
2. Dans une fixture temporaire, simuler un explorer qui répond vide à N puis révèle un candidat du même bloc à hash inchangé. Faire aussi varier epoch, délégué, client, fork et contribution Curve/FXN. Une proposition qui conserve le vide, distribue autrement ou masque une erreur échoue. Pour une source RPC, tester aussi reorg, réponse tronquée et échec partiel.
3. Comparer au plus deux solutions simples : dédupliquer uniquement les lectures véritablement identiques et complètes ; ou faire une collecte commune bornée suivie d’un filtrage local par délégué, avec contrôle de pagination et source complète. Utiliser le chemin RPC existant comme référence en lecture seule si son fournisseur accepte les plages et filtres nécessaires. Ne pas changer le fournisseur de production ni les logsSource des forks dans ce lot.
4. Si une solution gagne réellement et passe les cas adverses, mettre à jour ce fichier avec l’API exacte, les fichiers en périmètre, l’invalidation, les fixtures et les critères mesurés avant l’implémentation. Le périmètre maximal prévu est `onChainDelegation.ts`, son test existant et, seulement si nécessaire, `effectiveVotes.ts` et son test. Conserver par défaut les signatures des autres consommateurs. Le gain entre processus CI distincts reste nul sans cache persistant, lequel est hors périmètre.
5. Si les garanties ne peuvent être établies avec les sources existantes, clore l’étude avec décision « optimisation différée », chiffres et raison. Ne pas inventer un service d’indexation ou une tolérance financière pour débloquer le chantier.

Vérification initiale : `pnpm exec vitest run script/test/unit/onChainDelegation.test.ts script/test/unit/convexVotiumForwarderVp.test.ts script/test/unit/votiumClaimAllocations.test.ts script/test/unit/vlcvxDelegationSplit.test.ts`. Pour une implémentation retenue, étendre les tests existants et exiger `pnpm test:unit` ainsi que le rejeu déterministe avant/après : mêmes bénéficiaires, montants exacts, racines identiques ; poids toujours recalculés pour chaque plateforme et contrôle exact de complétude conservé.

## Critères et retour arrière

- [ ] Le cas « vide puis événement au même bloc, hash inchangé » est explicitement évalué et ne crée aucun candidat définitivement manquant.
- [ ] Le nombre de lectures évitées est mesuré sur des entrées comparables, après les changements de 003.
- [ ] Une preuve de complétude et d’isolation mainnet/fork existe avant toute activation ; sinon la décision de différer est consignée.
- [ ] Si implémenté, aucun poids partagé, aucune donnée persistante, aucun changement financier dans le rejeu.

Retour arrière éventuel : retirer la réutilisation mémoire, sans migration. Toute solution requérant un cache disque, une infrastructure supplémentaire ou une nouvelle règle de sélection des proposals est hors périmètre et doit être proposée séparément.

## Clôture à remplir

**DIFFÉRÉ.** Expérience temporaire exécutée après 003 : réponse vide puis deux événements visibles au même head fixe. Le premier appel échoue explicitement ; le second relit la plage et retrouve les deux bénéficiaires. Deux appels, zéro lecture évitée ; une mémorisation incrémentale du vide serait incorrecte. Ni la réponse explorer ni le hash RPC ne fournissent une preuve d’exhaustivité explorer.

Aucun cache, changement d’epoch, source RPC/fork ou partage de poids Curve/FXN ajouté. Les rescans restent identiques ; les 23 contrôles du run de référence ne sont pas annoncés comme supprimés. Le rejeu financier avant/après conserve bénéficiaires, montants et racine. Fixture temporaire supprimée après mesure ; résultats consignés dans [le journal](EXECUTION.md).
