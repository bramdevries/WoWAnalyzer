import { formatPercentage } from 'common/format';
import SPELLS from 'common/SPELLS';
import { SpellIcon, SpellLink } from 'interface';
import { SubSection } from 'interface/guide';
import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, { AnyEvent, CastEvent, EventType, HealEvent } from 'parser/core/Events';
import AbilityTracker from 'parser/shared/modules/AbilityTracker';
import HealingValue from 'parser/shared/modules/HealingValue';
import BoringValue from 'parser/ui/BoringValueText';
import { PerformanceBoxRow } from 'parser/ui/PerformanceBoxRow';
import Statistic from 'parser/ui/Statistic';
import STATISTIC_ORDER from 'parser/ui/STATISTIC_ORDER';

import { getHeals } from 'analysis/retail/druid/restoration/normalizers/CastLinkNormalizer';

/** Number of targets WG must effectively heal in order to be efficient */
const RECOMMENDED_EFFECTIVE_TARGETS_THRESHOLD = 3;
/** Max time after WG apply to watch for high overhealing */
const OVERHEAL_BUFFER = 3000;
/** Overheal percent within OVERHEAL_BUFFER of application that will count as 'too much' */
const OVERHEAL_THRESHOLD = 0.5;

/**
 * Tracks stats relating to Wild Growth
 */
class WildGrowth extends Analyzer {
  static dependencies = {
    abilityTracker: AbilityTracker,
  };

  abilityTracker!: AbilityTracker;

  recentWgTimestamp: number = 0;
  /** Tracker for the overhealing on targets hit by a recent hardcast Wild Growth, indexed by targetID */
  recentWgTargetHealing: {
    [key: number]: { appliedTimestamp: number; total: number; overheal: number };
  } = {};

  /** Total Wild Growth hardcasts (not tallied until the rest of the fields) */
  totalCasts = 0;
  /** Total Wild Growth HoTs applied by hardcasts */
  totalHardcastHits = 0;
  /** Total Wild Growth HoTs applied by hardcasts that didn't overheal too much early */
  totalEffectiveHits = 0;
  /** Wild Growth hardcasts that were 'ineffective' */
  ineffectiveCasts = 0;
  /** Wild Growth hardcasts that hit too many total targets (effective or not) */
  tooFewHitsCasts = 0;
  /** Wild Growth hardcasts that had too much early overhealing */
  tooMuchOverhealCasts = 0;

  /** Log of each WG cast, and how many targets were healed and how many were effective */
  castWgHitsLog: WgCast[] = [];

  constructor(options: Options) {
    super(options);
    this.addEventListener(Events.cast.by(SELECTED_PLAYER).spell(SPELLS.WILD_GROWTH), this.onCastWg);
    this.addEventListener(Events.heal.by(SELECTED_PLAYER).spell(SPELLS.WILD_GROWTH), this.onHealWg);
    this.addEventListener(Events.fightend, this.onFightEnd);
  }

  onFightEnd() {
    this._tallyLastCast(); // make sure the last cast is closed out
  }

  onCastWg(event: CastEvent) {
    this._tallyLastCast(); // make sure the previous cast is closed out
    this._trackNewCast(event);
  }

  onHealWg(event: HealEvent) {
    const recentWgHealTracker = this.recentWgTargetHealing[event.targetID];
    if (recentWgHealTracker !== undefined) {
      const healVal = new HealingValue(event.amount, event.absorbed, event.overheal);
      recentWgHealTracker.total += healVal.raw;
      recentWgHealTracker.overheal += healVal.overheal;
    }
  }

  /**
   * Follows the 'AppliedHeal' tag from the CastEvents to each of the HoTs it created,
   * and initializes a recentWgTargetHealing entry for each.
   */
  _trackNewCast(event: CastEvent) {
    this.recentWgTargetHealing = {};
    this.recentWgTimestamp = event.timestamp;
    getHeals(event).forEach(
      (applyHot: AnyEvent) =>
        (applyHot.type === EventType.ApplyBuff || applyHot.type === EventType.RefreshBuff) &&
        (this.recentWgTargetHealing[applyHot.targetID] = {
          appliedTimestamp: applyHot.timestamp,
          total: 0,
          overheal: 0,
        }),
    );
  }

  /**
   * Closes out the 'recent cast' tallies if there is one open and enough time has passed
   */
  _tallyLastCast() {
    this.totalCasts += 1;
    if (this.totalCasts === 1) {
      return; // there is no last cast
    }

    const hits = Object.values(this.recentWgTargetHealing);
    const effectiveHits = hits.filter((wg) => wg.total * OVERHEAL_THRESHOLD > wg.overheal).length;
    this.totalEffectiveHits += effectiveHits;

    if (effectiveHits < RECOMMENDED_EFFECTIVE_TARGETS_THRESHOLD) {
      this.ineffectiveCasts += 1;
      if (hits.length - effectiveHits >= 2) {
        this.tooMuchOverhealCasts += 1;
      }
      if (hits.length < RECOMMENDED_EFFECTIVE_TARGETS_THRESHOLD) {
        this.tooFewHitsCasts += 1;
      }
    }

    this.castWgHitsLog.push({
      timestamp: this.recentWgTimestamp,
      hits: hits.length,
      effectiveHits,
    });
  }

  get averageEffectiveHits() {
    return this.totalEffectiveHits / this.totalCasts || 0;
  }

  get actualRejuvCasts() {
    return this.abilityTracker.getAbility(SPELLS.REJUVENATION.id).casts || 0;
  }

  /** Guide subsection describing the proper usage of Wild Growth */
  get guideSubsection(): JSX.Element {
    const castPerfBoxes = this.castWgHitsLog.map((wgCast) => ({
      value: wgCast.effectiveHits >= 3,
      tooltip: `@ ${this.owner.formatTimestamp(wgCast.timestamp)} - Hits: ${
        wgCast.hits
      }, Effective: ${wgCast.effectiveHits}`,
    }));
    return (
      <SubSection>
        <p>
          <b>
            <SpellLink id={SPELLS.WILD_GROWTH.id} />
          </b>{' '}
          is your best healing spell when multiple raiders are injured. It quickly heals a lot of
          damage, but has a high mana cost. Use Wild Growth over Rejuvenation if there are at least
          3 injured targets. Remember that only allies within 30 yds of the primary target can be
          hit - don't cast this on an isolated player!
        </p>
        <strong>Wild Growth casts</strong>
        <small>
          {' '}
          - Green is a good cast, Red was effective on fewer than three targets. A hit is considered
          "ineffective" if over the first 3 seconds it did more than 50% overhealing. Mouseover
          boxes for details.
        </small>
        <PerformanceBoxRow values={castPerfBoxes} />
      </SubSection>
    );
  }

  statistic() {
    return (
      <Statistic
        size="flexible"
        position={STATISTIC_ORDER.CORE(19)}
        tooltip={
          <>
            This is the average number of effective hits per Wild Growth cast. Because its healing
            is so frontloaded, we consider a hit effective only if it does less than{' '}
            {formatPercentage(OVERHEAL_THRESHOLD, 0)}% overhealing over its first{' '}
            {(OVERHEAL_BUFFER / 1000).toFixed(0)} seconds.
            <br /> <br />
            This statistic only considers hardcasts, Wild Growths procced by Convoke the Spirits are
            ignored.
          </>
        }
      >
        <BoringValue
          label={
            <>
              <SpellIcon id={SPELLS.WILD_GROWTH.id} /> Average Effective Wild Growth Hits
            </>
          }
        >
          <>{this.averageEffectiveHits.toFixed(1)}</>
        </BoringValue>
      </Statistic>
    );
  }
}

type WgCast = { timestamp: number; hits: number; effectiveHits: number };

export default WildGrowth;