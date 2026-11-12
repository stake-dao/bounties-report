# Exécution — optimisation CI

12 novembre 2026. Worktree isolé `fix/ci-network-efficiency`, base distante vérifiée `a9f0778229e230502f9c9fe9bd20bcd4c029a692`. Aucun changement du checkout original ni du worktree `delegation-freshness`. Aucun workflow financier dispatché, aucune donnée générée modifiée, aucun changement de schedule de production, aucune fusion main.

## Décisions

- 001 exécuté en premier : retrait de Snapshot après les claims Votium uniquement. Le cache des forwarders reste requis avant génération ; Ethereum-only n’est pas imposé aux produits BSC/Base/Votemarket.
- 002 partagé avec [PR #251](https://github.com/stake-dao/bounties-report/pull/251), commit [7aad8f63](https://github.com/stake-dao/bounties-report/commit/7aad8f63e20d6081c2777ebc170730048c2e44be), vérifié via GitHub comme tête de PR ouverte. Cette branche contient les collecteurs, pas le correctif CLI/GraphQL d’un autre propriétaire. Pas de duplication ni d’intégration de son patch.
- Extension d’intégrité aux forwarders : les mêmes erreurs de borne finale, corruption masquée et réponse manquante ont été reproduites par leurs API publiques. Coût : un cache précédemment illisible fait désormais échouer la collecte au lieu d’être écrasé.
- 003 utilise une seule politique explorer par processus ; elle ne protège pas contre la concurrence de plusieurs jobs utilisant la même clé. Un NOTOK inconnu échoue au lieu d’attendre aveuglément. La cause historique reste non établie.
- 004 différé : aucune source existante ne prouve l’exhaustivité du snapshot explorer. Coût : rescans vlCVX conservés, pas de gain réseau annoncé pour ce lot.
- 005 garde les workflows anciens sans action setup autonomes. Compute APR conserve son override non-frozen explicite ; aucune raison de changer ses calculs ou sa publication dans cette adaptation Make.
- Correction du plan : main contient une CI PR non publiante, `Recovery regressions`, qui couvre les nouveaux tests. Le constat initial d’absence de CI de tests était inexact.
- Rejeu financier exécuté avec les deux versions du helper dans une seule sandbox de test plutôt que deux worktrees complets : mêmes consommateurs de production et mêmes entrées externes contrôlées, seuls les helpers diffèrent. Aucun script de pipeline de haut niveau lancé.

## Vérifications

Installation propre : `pnpm install --frozen-lockfile --ignore-workspace`, réussie sans mutation de package.json/pnpm-lock.yaml. `--ignore-workspace` est nécessaire uniquement sur GrosMac à cause du workspace utilisateur parent. Lancer Vitest directement avec `PNPM_WORKSPACE_DIR="$PWD" ./node_modules/.bin/vitest run` évite que le test de sous-processus pnpm hérite du mauvais workspace. La première exécution via `pnpm test` présentait un faux échec de `guardCompletionFailure.test.ts` (`packages field missing or empty`) ; le même test passe avec l’environnement local corrigé, sans changement de source.

Suite complète exécutée après la correction de revue : **63 fichiers passés, 2 ignorés ; 602 tests passés, 3 ignorés**, zéro échec. Les nouveaux tests permanents couvrent 15 contrats explorer et 7 cas de checkpoint. Revue indépendante : une variante transitoire Etherscan documentée (« server too busy ») manquait à la classification ; régression observée rouge puis verte après correction minimale. Aucun autre défaut introduit confirmé par la revue.

Contrôles YAML : assertions de dépendances Claims rouge puis verte ; actionlint sans ShellCheck valide. ShellCheck signale des diagnostics préexistants, conservés et comparés au HEAD initial, pas une validation ShellCheck entièrement verte. L’indexeur global et ses chaînes sont inchangés.

Lot 005 : dry-runs locaux/CI des dix Makefiles et shim isolé (scripts financiers neutralisés) : **une installation frozen, quinze commandes tsx, zéro add**. Test Make existant : 25/25. Cache réel GitHub hit/miss et durée du prochain workflow non mesurés ici.

## Rejeu financier déterministe

Chemin de production : explorer → `getOnChainDelegators` → `computeStakeDaoDelegation` → `generateMerkleTree`. RPC, forwarding, résolution du bloc et réponses explorer contrôlés ; calculs d’attribution et Merkle réels, sans fichiers financiers écrits. Deux poids distincts 2:1, pot 1000 wei : **667 wei** pour `0x2222222222222222222222222222222222222222` et **333 wei** pour `0x3333333333333333333333333333333333333333`, token `0x4444444444444444444444444444444444444444` sur Ethereum.

Avant/après : mêmes bénéficiaires, montants, preuves et racine `0xda026e0aea31d93bdaab076497b547b2842d3d6aa69045b5194219fdba82a6c0`. Une requête sans erreur dans chaque version, zéro retry ; durée simulée zéro pour cette entrée unique. Ce résultat n’est ni une reconstruction de toutes les distributions historiques ni une mesure de durée GitHub.

Étude cache : head identique, première réponse vide puis événements visibles ; le second appel récupère les deux candidats. Deux requêtes, zéro évitée. Cache non activé. Les validations existantes d’epoch, complétude exacte, Curve/FXN et forks restent inchangées.

Sonde réelle read-only Ethereum du registre Snapshot `0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446`, blocs 26390000–26390100 : réponse vide valide, 487 ms. Pas de NOTOK reproduit ; aucune conclusion de rate-limit historique.

## Diagnostic sdCRV reproduit indépendamment

Source : `https://snapshot-indexer.contact-69d.workers.dev/v1/graphql`, `chain_metadata` Ethereum : bloc **26247263**, progression déclarée `2026-10-22T09:28:02.374+00:00`. Les quatre événements Set du Parquet publié sont ultérieurs :

| Adresse | Bloc Set |
| --- | --- |
| `0xe1f8afc92644bfe77080d7dcb0f936f578e00f53` | 26289842 |
| `0xccf3dfcd5ad3d9ab6507d46717483e46cddea5f0` | 26298308 |
| `0x4e073511bfe70a33fe0dcd7e2e783ff043130667` | 26310494 |
| `0xc4fc7075c4d60107b051c6f35026dbaf7865e1de` | 26364024 |

Quatre lectures RPC `delegation(address,bytes32(sdcrv.eth))` sur le registre ci-dessus, au bloc Ethereum **26399808**, hash **0xb275c29c61aab3daa1df1ae240526f3df1b48a832931140dbd51ccdbe8af0236** : toutes retournent `0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC`. Les lignes ne doivent pas être supprimées pour satisfaire une API périmée. Cela établit le retard de couverture constaté, sans prétendre reconstruire la disponibilité de l’API au moment du run historique.

## Livraison

Code signé en trois commits distincts sur `fix/ci-network-efficiency` : retrait d’indexation inutile, protection des checkpoints/politique réseau, puis réutilisation du setup CI. Revue finale effectuée et sa correction vérifiée. Le statut distant de la PR et de sa CI est suivi dans le rapport associé au thread ; tests locaux verts ne signifient pas CI verte. La fusion main et toute relance publiante nécessitent une autorisation explicite. Le coût supprimé du run de référence est **14 min 03 s** ; aucun nouveau benchmark de CI financière n’a été déclenché.

## Regroupement des PR #251 et #252

Le 12 novembre, l’utilisateur a demandé une seule PR pour simplifier la revue. La branche `fix/delegation-indexer-freshness` réunit les changements RPC/CLI de [f7161f7f](https://github.com/stake-dao/bounties-report/commit/f7161f7f23b0b34c229653542fb545c5402a679a) et les quatre commits CI jusqu’à [46fe3c62](https://github.com/stake-dao/bounties-report/commit/46fe3c622ca735465a566c3d7b1e1a9c4adf03f5), par fusion sans conflit conservant leurs historiques. La [PR #251](https://github.com/stake-dao/bounties-report/pull/251) est l’unique point de revue de cet ensemble ; #252 est remplacée, sans suppression de sa branche. Les constats de livraison séparée ci-dessus décrivent l’étape précédente.

Vérification combinée locale : **616 tests passés, 3 ignorés ; 65 fichiers passés, 2 ignorés**, via `npm_config_ignore_workspace=true node_modules/.bin/vitest run`. Actionlint sans ShellCheck valide pour les quatre workflows modifiés ; dry-runs des cibles Make forwarders, delegators et claims Votium avec `CI_SETUP_DONE=1` sans réinstallation. Aucun script financier de haut niveau exécuté.

Lecture RPC réelle avec les deux lots intégrés au bloc snapshot **26397955**, hash `0x80b63206bee838f41819b78fe22e51c10fb9d48b76431f3c98da02475e3b6494` : accord des six espaces, respectivement sdfxs 308, sdcrv 1165, sdbal 321, sdangle 265, sdfxn 262 et cvx Snapshot legacy 540. Une première tentative RPC a été refusée ; la tentative instrumentée suivante a réussi, sans modification du vérificateur ni cause du refus établie. Aucun merge main, aucune génération de données, aucune cascade ou transaction lancée pendant le regroupement.
