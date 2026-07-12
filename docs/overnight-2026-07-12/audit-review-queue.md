# Audit review queue -- morning human review

The audit auto-apply path **failed its gold2 gate** (adjusted ship-stratum false-change rate 28-38% vs. the 2% bar -- see `pipeline/data/evidence/gold2-gate.md` and `docs/overnight-2026-07-12/STATE.md`, 10:12 CDT). **No existing pack entry was auto-changed.** This file is the human one-click substitute: every proposed fix below, with its source, rationale, and (for engine-proposed changes) whether the independent gold2 Opus labels agree.

- **69 rows** from `gold2-opus` -- Opus-labeled corrections at effort-high (the highest-confidence source; these can be applied close to as-is after a skim).
- **43 rows** from `engine-ship-agreed` -- engine v2 changes that would have auto-shipped, and gold2 independently reached the same verdict.
- **25 rows** from `engine-ship-disagreed` -- engine v2 changes that would have auto-shipped, but gold2 disagrees (mostly gold2 says the current entry is already fine). Treat these as **likely false positives** unless the rationale's hand-review says otherwise -- lean toward rejecting.
- **137 rows total.**

## Precision context per language (gold2-gate, n=570 pooled)

| lang | n | agreement | falseKeep | shipStratumFalseChange | adjShipFalseChange (hand-reviewed) | nShipChanges |
|---|---|---|---|---|---|---|
| de | 150 | 92.0% | 20.0% (3/15) | 37.5% (6/16) | 37.5% (6/16) | 16 |
| es | 120 | 88.3% | 12.5% (2/16) | 38.5% (5/13) | 30.8% (4/13) | 13 |
| fr | 150 | 92.7% | 15.0% (3/20) | 28.6% (6/21) | 28.6% (6/21) | 21 |
| it | 150 | 92.7% | 11.1% (2/18) | 27.8% (5/18) | 27.8% (5/18) | 18 |
| **pooled** | 570 | 91.6% | 14.5% (10/69) | 32.4% (22/68) | 30.9% (21/68) | 68 |

`shipStratumFalseChange` is the raw rate of ship-stratum changes gold2 says are unwarranted; `adjShipFalseChange` divides only the hand-confirmed engine-wrong ones by the same denominator (a few disagreements were reclassified gold-suspect on review -- see `pipeline/data/evidence/gold2-gate.md`). Both are well above the 2% ship bar for every language, which is why this stayed a review queue instead of an auto-apply.

## Counts by language and provenance

| lang | gold2-opus | engine-ship-agreed | engine-ship-disagreed | total |
|---|---|---|---|---|
| de | 15 | 10 | 6 | 31 |
| es | 16 | 7 | 6 | 29 |
| fr | 20 | 15 | 6 | 41 |
| it | 18 | 11 | 7 | 36 |
| **total** | 69 | 43 | 25 | 137 |

## Top-20 preview per language (by enZipf desc -- commonest words first)

### de (31 rows)

| key | source | currentTarget | verdict | proposedTarget | prov | enZipf | rationale |
|---|---|---|---|---|---|---|---|
| middle voice | middle voice | Medium | gate |  | gold2 | 4.82 | 'Medium' is technically the grammatical middle voice but its overwhelmingly dominant sense is media/medium; no clean dominant target (the freedict alt is a mis… |
| class-based language | class-based language | objektbasierte Sprache | gate |  | gold2 | 4.81 | objektbasierte Sprache = object-based language, the CONTRASTING PL concept, not class-based (klassenbasiert). Wrong and no alternative. |
| indian summer | indian summer | heißer Herbst | retarget | Altweibersommer | gold2 | 4.74 | 'heißer Herbst' means the political-unrest sense (see currentTargetGlosses); the weather phenomenon Indian summer = Altweibersommer. |
| indian summer | indian summer | heißer Herbst | retarget | Altweibersommer | agree | 4.74 | Current 'heißer Herbst' teaches the political-conflict sense per its own currentTargetGlosses, not the weather sense; Altweibersommer is the dictionary-standar… |
| civil engineer | civil engineer | Tiefbauingenieur | retarget | Bauingenieur | gold2 | 4.36 | civil engineer generally = Bauingenieur; Tiefbauingenieur is a narrower sub-specialty (underground/infrastructure), non-dominant. |
| civil engineer | civil engineer | Tiefbauingenieur | retarget | Bauingenieur | agree | 4.36 | Tiefbauingenieur is a narrower specialization (heavy/underground civil engineering); Bauingenieur is the standard, dominant general term for 'civil engineer',… |
| puzzle box | puzzle box | Himitsu Bako | gate |  | gold2 | 3.93 | 'Himitsu Bako' is a Japanese loanword, not a German word; teaches nothing German and no alternative exists. |
| heel | heel | Absatz | retarget | Ferse | gold2 | 3.84 | entrSense is the body-part heel = Ferse; Absatz's dominant senses are shoe-heel/paragraph/ledge (see currentTargetGlosses on absetzen). Absatz morphology itsel… |
| heel | heel | Absatz | retarget | Ferse | agree | 3.84 | 'Absatz' means shoe-heel/paragraph (its own gloss is 'verbal noun of absetzen'), not the anatomical rear-of-foot sense; 'Ferse' is the highest-voted (3 sources… |
| tempo | tempo | Geschwindigkeit | retarget | Tempo | DISAGREE | 3.74 | Geschwindigkeit means physical speed/velocity, not the pace/rate sense of 'tempo' (music/activity pace); entr marks both entry senses false. Tempo is the unani… |
| magnetic poles | magnetic poles | polarisieren | gate |  | gold2 | 3.70 | Source 'magnetic poles' (Magnetpole, noun) is mapped to polarisieren (verb 'to polarize'); wrong POS/sense and no alternative. |
| magnetic poles | magnetic poles | polarisieren | gate |  | agree | 3.70 | polarisieren is a verb ('to polarize') with no sense overlapping the noun phrase 'magnetic poles' [gold2 agrees (gate): Source 'magnetic poles' (Magnetpole, no… |
| candid | candid | direkt | retarget | unvoreingenommen | DISAGREE | 3.45 | direkt teaches frank/blunt speech, not the gloss's impartial/unprejudiced sense; unvoreingenommen matches literally [gold2 says KEEP: direkt = direct/forthrigh… |
| cramped | cramped | verkrampft | retarget | beengt | gold2 | 3.28 | entrSense is spatial (uncomfortably restricted in size/space) = beengt/eng; verkrampft = tense/spasmed is the muscular sense, wrong here. |
| cramped | cramped | verkrampft | retarget | beengt | agree | 3.28 | verkrampft means muscularly/emotionally tense, not restricted in space or financially as the entry gloss specifies; beengt is the direct dictionary match [gold… |
| shunned | shunned | aussätzig | retarget | gemieden | gold2 | 3.11 | aussätzig primarily = leprous; shunned = avoided = gemieden (past participle of meiden), the dominant sense. |
| oxidizing conditions | oxidizing conditions | Oxidationszustand | gate |  | gold2 | 2.60 | Oxidationszustand = oxidation STATE, a distinct chemistry concept, not oxidizing conditions (oxidierende Bedingungen). Wrong target and no usable alternative. |
| expound | expound | verbreiten | retarget | darlegen | gold2 | 2.49 | verbreiten = to spread/disseminate (wrong sense); expound = to set out/explain = darlegen/erläutern. |
| expound | expound | verbreiten | retarget | darlegen | agree | 2.49 | verbreiten's own glosses are spread/circulate/disseminate, not 'set out the meaning of/explain at length'; darlegen's gloss matches the entry gloss verbatim (a… |
| doldrums | doldrums | Mallung | retarget | Flaute | gold2 | 2.43 | Mallung is an obscure nautical term; the dominant 'in the doldrums' slump sense = Flaute. Mallung morphology itself is fine. |

### es (29 rows)

| key | source | currentTarget | verdict | proposedTarget | prov | enZipf | rationale |
|---|---|---|---|---|---|---|---|
| network social | network social | pack | gate |  | gold2 | 4.87 | broken entry: mangled source and target 'pack' is meaningless |
| helping hand | helping hand | mano auxiliar | gate |  | DISAGREE | 4.69 | mano auxiliar reads as the mechanical/tool sense (auxiliary hand), not the idiomatic assistance sense in the entry gloss (containsCurrent false); no alternativ… |
| former ceo | former ceo | exencargado | gate |  | gold2 | 4.40 | 'encargado' is a manager not a CEO; junk compound, mistranslation |
| pen | pen | redactar | retarget | bolígrafo | gold2 | 4.38 | dominant sense of pen is the writing instrument (bolígrafo); 'redactar' teaches the minor verb sense |
| security blanket | security blanket | coraza | gate |  | gold2 | 4.04 | 'coraza' means armor/shell, wrong for a comfort/security blanket; no usable alternative |
| security blanket | security blanket | coraza | gate |  | agree | 4.04 | coraza (armor/shield) is a wrong sense for the childhood-blanket meaning (containsCurrent false), and no gloss-matching alternative is listed [gold2 agrees (ga… |
| reversal | reversal | revocación | retarget | inversión | gold2 | 3.56 | 'revocación' is the narrow legal reversal; dominant reversal sense is inversión |
| reversal | reversal | revocación | retarget | inversión | agree | 3.56 | Adjudicating against the entry gloss 'The state of being reversed' (generic) = OMW rank1 'a change from one state to the opposite state', whose targets are inv… |
| mclaren | mclaren | McLaren | gate |  | gold2 | 3.49 | proper noun (car marque/surname) |
| mclaren | mclaren | McLaren | gate |  | agree | 3.49 | proper noun (brand/surname), no dictionary sense evidence [gold2 agrees (gate): proper noun (car marque/surname)] |
| hastily turn down | hastily turn down | inadmitir | gate |  | gold2 | 3.29 | source is a non-lexical junk phrase; 'inadmitir' (reject an appeal) does not map to it |
| castor | castor | ricino | gate |  | gold2 | 3.18 | 'castor' is highly polysemous (beaver/caster-wheel/star/plant); 'ricino' teaches only the castor-oil-plant sense, no clean dominant target |
| castor | castor | ricino | gate |  | agree | 3.18 | Refuter correct. Adjudicate against the entry's own gloss ('a hat made from the fur of the beaver'). Current 'ricino' is the castor-oil plant -- a different se… |
| triplet | triplet | terceto | retarget | trío | DISAGREE | 2.70 | terceto does not match entr's own 'set of three' gloss (containsCurrent false); trío matches that gloss and omw rank1 with 2 votes and morph authority [gold2 s… |
| polemical | polemical | candente | retarget | polémico | gold2 | 2.49 | 'candente' means red-hot/topical, not polemical; dominant target is polémico |
| polemical | polemical | candente | retarget | polémico | agree | 2.49 | candente means hot/burning (topic), not argumentative; entr flags mismatch; polémico is the exact OMW rank-1 cognate [gold2 agrees (retarget): 'candente' means… |
| worldliness | worldliness | mundo | retarget | mundología | gold2 | 2.04 | 'mundo' means world, not worldliness; mundología teaches worldly-wisdom |
| worldliness | worldliness | mundo | gate |  | DISAGREE | 2.04 | Current 'mundo' (world) is wrong for worldliness, so keep is out. The precise gloss-matching candidate mundologia (2 votes entr+omw, carries the entry gloss ve… |
| lusatia | lusatia | Lusacia | gate |  | gold2 | 1.43 | proper noun (region Lusatia=Lusacia) |
| lusatia | lusatia | Lusacia | gate |  | agree | 1.43 | toponym with zero morph authority and zero evidence; gate per policy [gold2 agrees (gate): proper noun (region Lusatia=Lusacia)] |

### fr (41 rows)

| key | source | currentTarget | verdict | proposedTarget | prov | enZipf | rationale |
|---|---|---|---|---|---|---|---|
| christian woman | christian woman | goja | gate |  | gold2 | 4.75 | 'goja' is an obscure/non-standard term for Christian woman; not a teachable target, no alternatives. |
| christian woman | christian woman | goja | gate |  | agree | 4.75 | goja/goï denotes a non-Jewish woman (Yiddish-derived slang), a different and sensitive sense than 'Christian woman'; no gloss-matching alternative offered [gol… |
| buildings | buildings | angle | gate |  | gold2 | 4.69 | 'buildings' mapped to 'angle' (angle/corner) is a broken inversion; should be batiments, no alternatives. |
| buildings | buildings | angle | gate |  | agree | 4.69 | angle means 'corner/angle', not 'buildings' - the entry's own currentTargetGlosses describe 'angle' as a corner-of-a-building sense, an unrelated word to the s… |
| reveal | reveal | découvrir | retarget | révéler | gold2 | 4.43 | decouvrir leads with 'discover/uncover'; the direct match for reveal is reveler (available). |
| reveal | reveal | découvrir | retarget | révéler | agree | 4.43 | découvrir's dominant sense is discover, not reveal; entr flags mismatch; révéler has 4-source consensus and an exact OMW rank-1 match [gold2 agrees (retarget):… |
| connections | connections | piston | gate |  | gold2 | 4.32 | 'connections' primarily = relations; piston is a narrow colloquial 'pull' sense, misleading, no clean alternative offered. |
| connections | connections | piston | gate |  | agree | 4.32 | Entry gloss is horse-racing jargon (the owner/trainer/jockey team of a racehorse); piston is French career-nepotism 'pull' - a different referent. Raw conceded… |
| moral strength | moral strength | abattement | gate |  | gold2 | 4.30 | abattement = dejection/loss of strength, the OPPOSITE of moral strength; inversion error, no alternatives. |
| fiscal | fiscal | fiscal | gate |  | DISAGREE | 4.26 | non-noun target identical to the English source; teaches nothing [gold2 says KEEP: fiscal is correct.; hand-reviewed: engine-wrong] |
| relate | relate | relater | gate |  | gold2 | 4.24 | 'relate' is polysemous and modernly dominant in the connect sense; relater = recount only, no clean single dominant target. |
| great delight | great delight | malin plaisir | gate |  | gold2 | 3.96 | 'malin plaisir' means malicious/wicked delight, not neutral great delight; no clean alternative offered. |
| great grey owl | great grey owl | chouette cendrée | retarget | chouette lapone | gold2 | 3.77 | 'chouette cendree' is not the standard name for Strix nebulosa; the standard is chouette lapone (available). |
| breakaway | breakaway | percée | retarget | échappée | gold2 | 3.19 | percee teaches 'breakthrough'; the dominant sports sense breakaway = echappee is available. |
| breakaway | breakaway | percée | retarget | échappée | agree | 3.19 | percée=breakthrough matches neither entrySense (both containsCurrent:false), so the current target is genuinely wrong-sense and keep is not an option. The rate… |
| noun adjective | noun adjective | nom adjectif | gate |  | DISAGREE | 3.15 | multiword junk entry, no evidence, garbled self back-translation [gold2 says KEEP: nom adjectif is a real (dated) grammatical term matching the gloss.; hand-re… |
| condescending | condescending | méprisant | retarget | condescendant | gold2 | 3.10 | meprisant teaches 'contemptuous/scornful'; the dominant match condescendant is available. |
| condescending | condescending | méprisant | retarget | condescendant | agree | 3.10 | mepris(ant)=contemptuous/scornful, wrong/harsher sense; entry gloss ('patronizing tone') is verbatim among condescendant's glosses, 2 votes. [gold2 agrees (ret… |
| exclamation | exclamation | protestation | retarget | exclamation | gold2 | 3.09 | protestation teaches 'protest'; the direct cognate exclamation is available. |
| exclamation | exclamation | protestation | retarget | exclamation | agree | 3.09 | protestation teaches the protest/complaint sense; the gloss is the abrupt-utterance sense, which the French cognate 'exclamation' matches directly [gold2 agree… |

### it (36 rows)

| key | source | currentTarget | verdict | proposedTarget | prov | enZipf | rationale |
|---|---|---|---|---|---|---|---|
| trade fair | trade fair | fiera | retarget | fiera campionaria | DISAGREE | 4.75 | fiera alone is polysemous (fair/wild animal) and entr flags the sense as non-matching; fiera campionaria is the 2-source-confirmed precise term [gold2 says KEE… |
| transfer | transfer | tradizione | retarget | trasferimento | gold2 | 4.72 | 'tradizione' = tradition, wrong sense for common word transfer = 'trasferimento'. |
| transfer | transfer | tradizione | retarget | trasferimento | agree | 4.72 | tradizione means 'tradition', an unrelated wrong sense; trasferimento is the dominant noun sense of transfer, backed by 4 sources [gold2 agrees (retarget): 'tr… |
| neighborhood | neighborhood | vicino | retarget | quartiere | gold2 | 4.50 | 'vicino' = neighbor/near; neighborhood (residential area) = 'quartiere'. |
| neighborhood | neighborhood | vicino | retarget | quartiere | agree | 4.50 | Current vicino (neighbor/near) is wrong (containsCurrent false), so keep is out. Entry gloss 'The residential area near one's home' is a bounded residential di… |
| lie flat | lie flat | spianare | gate |  | DISAGREE | 4.47 | spianare's glosses (level/raze/roll pasta) don't cover 'lie flat'; no entry senses or alternatives to fix it [gold2 says KEEP: Current target renders the domin… |
| shots fired | shots fired | strale | gate |  | gold2 | 4.33 | 'strale' (arrow/thunderbolt) does not teach the expression 'shots fired'; no usable single-word target. |
| habit | habit | costume | retarget | abitudine | gold2 | 4.24 | 'costume' = custom/costume; dominant 'habit' (routine) = 'abitudine'. |
| habit | habit | costume | retarget | abitudine | agree | 4.24 | costume teaches costume/swimsuit, matching none of the 3 listed entry senses; abitudine renders the dominant custom/routine sense, 4/4 source votes + full morp… |
| informal | informal | alla buona | retarget | informale | gold2 | 3.87 | 'alla buona' is a colloquial phrase; the dominant adjective 'informal' = 'informale'. |
| narrative verdict | narrative verdict | interlocuzione | gate |  | gold2 | 3.87 | 'narrative verdict' is a niche legal term; 'interlocuzione' = dialogue/interlocution, wrong sense; no alternative. |
| rear admiral | rear admiral | commodoro | retarget | contrammiraglio | gold2 | 3.86 | 'commodoro' = commodore, wrong rank; rear admiral = 'contrammiraglio'. |
| rear admiral | rear admiral | commodoro | retarget | contrammiraglio | agree | 3.86 | commodoro teaches commodore, a different rank than rear admiral per entry gloss; contrammiraglio is the standard rank term, unanimous votes + full morph [gold2… |
| breath mint | breath mint | cicca | gate |  | gold2 | 3.82 | 'cicca' = cigarette butt / chewing gum, not breath mint (mentina); wrong sense, no clean alternative. |
| breath mint | breath mint | cicca | gate |  | agree | 3.82 | cicca's glosses are all cigarette-butt/worthless-thing senses; none match breath mint, no candidate offered [gold2 agrees (gate): 'cicca' = cigarette butt / ch… |
| tidy | tidy | pulito | retarget | ordinato | gold2 | 3.53 | 'pulito' = clean; 'tidy' (neat/orderly) = 'ordinato'. |
| tidy | tidy | pulito | retarget | ordinato | agree | 3.53 | both entrySenses flag current 'pulito' (clean) as non-matching; ordinato (3-source agreement) matches 'arranged neatly and in order' exactly [gold2 agrees (ret… |
| haunting | haunting | ossessivo | gate |  | DISAGREE | 3.52 | Adjectival haunting (lingering/evocative) has NO independent gloss-matching evidence: entrSenses is an unrelated noun ghost-sense (containsCurrent=false) and e… |
| resilient | resilient | di ferro | retarget | resiliente | gold2 | 3.50 | 'di ferro' = iron/tough idiom; the elastic-resilience sense = 'resiliente'. |
| resilient | resilient | di ferro | retarget | elastico | agree | 3.50 | di ferro is a toughness idiom for people/health, not the gloss's physical elastic-recoil sense; elastico matches the gloss exactly with confirmed morph [gold2… |

