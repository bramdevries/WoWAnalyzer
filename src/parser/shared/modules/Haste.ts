import { formatMilliseconds, formatPercentage } from 'common/format';
import SPELLS from 'common/SPELLS';
import CLASSIC_SPELLS from 'common/SPELLS/classic';
import { TALENTS_DEATH_KNIGHT, TALENTS_MAGE, TALENTS_PRIEST } from 'common/TALENTS';
import BLOODLUST_BUFFS from 'game/BLOODLUST_BUFFS';
import Analyzer, { Options } from 'parser/core/Analyzer';
import Combatant from 'parser/core/Combatant';
import EventFilter, { SELECTED_PLAYER } from 'parser/core/EventFilter';
import Events, {
  Item,
  AnyEvent,
  ApplyBuffEvent,
  ApplyDebuffEvent,
  ChangeBuffStackEvent,
  ChangeDebuffStackEvent,
  ChangeStatsEvent,
  EventType,
  SourcedEvent,
  RemoveBuffEvent,
  RemoveDebuffEvent,
} from 'parser/core/Events';
import EventEmitter from 'parser/core/modules/EventEmitter';
import StatTracker from 'parser/shared/modules/StatTracker';

const debug = false;

interface HasteBuff {
  itemId?: number;
  hastePerStack?: number;
  haste?: number;
}

type HasteBuffMap = { [spellId: number]: number | HasteBuff };

const HASTE_BUFFS: HasteBuffMap = {
  // HASTE RATING BUFFS ARE HANDLED BY THE STATTRACKER MODULE

  ...BLOODLUST_BUFFS,
  [SPELLS.BERSERKING.id]: 0.1,
  [SPELLS.IN_FOR_THE_KILL_TALENT_BUFF.id]: 0.1,
  [SPELLS.REVERSE_ENTROPY_BUFF.id]: 0.15,
  [SPELLS.ENRAGE.id]: 0.25, // Fury Warrior

  //region Demon Hunter
  [SPELLS.METAMORPHOSIS_HAVOC_BUFF.id]: 0.25,
  [SPELLS.FURIOUS_GAZE.id]: 0.1, // Havoc DH haste buff from fully channeling a cast of Eye Beam
  //endregion

  //region Death Knight Haste Buffs
  [SPELLS.BONE_SHIELD.id]: 0.1, // Blood BK haste buff from maintaining boneshield
  [SPELLS.EMPOWER_RUNE_WEAPON.id]: 0.15,
  [TALENTS_DEATH_KNIGHT.UNHOLY_ASSAULT_TALENT.id]: 0.3,
  [SPELLS.T29_GHOULISH_INFUSION.id]: 0.08,
  [SPELLS.UNHOLY_GROUND_HASTE_BUFF.id]: 0.05,
  //endregion

  //region Druid Haste Buffs
  [SPELLS.STARLORD.id]: {
    hastePerStack: 0.04,
  },
  [SPELLS.CELESTIAL_ALIGNMENT.id]: 0.1,
  [SPELLS.INCARNATION_CHOSEN_OF_ELUNE.id]: 0.1,
  [SPELLS.NATURES_GRACE.id]: 0.15,
  [SPELLS.FRANTIC_MOMENTUM.id]: 0.1, // TODO check for possible tuning updates
  //endregion

  //region Hunter Haste Buffs
  [SPELLS.DIRE_BEAST_BUFF.id]: 0.05,
  [SPELLS.STEADY_FOCUS_BUFF.id]: 0.07,
  //endregion

  //region Paladin
  [SPELLS.RELENTLESS_INQUISITOR_TALENT_BUFF.id]: {
    hastePerStack: 0.01,
  },

  //region Priest
  [TALENTS_PRIEST.POWER_INFUSION_TALENT.id]: 0.2,
  [SPELLS.BORROWED_TIME_BUFF.id]: 0.08,
  [SPELLS.SHADOW_PRIEST_TIER_29_4_SET_BUFF.id]: 0.04,
  //endregion

  //region Mage
  [TALENTS_MAGE.ICY_VEINS_TALENT.id]: 0.3,
  [TALENTS_MAGE.TOME_OF_ANTONIDAS_TALENT.id]: 0.02,
  //endregion

  //region Monk
  [SPELLS.INVOKERS_DELIGHT_BUFF.id]: 0.33,
  [SPELLS.FURY_OF_XUEN_BUFF.id]: 0.05,
  [SPELLS.SECRET_INFUSION_HASTE_BUFF.id]: 0, // manually set in monk files
  [SPELLS.LESSON_OF_FEAR_BUFF.id]: 0.25,
  //endregion

  //region Shaman
  [SPELLS.ELEMENTAL_BLAST_HASTE.id]: 0.03,
  //endregion

  //region CLASSIC
  // Raids
  [CLASSIC_SPELLS.SHADOW_CRASH.id]: 1, // Ulduar - General Vezax
  [CLASSIC_SPELLS.SLAG_IMBUED.id]: 1, // Ulduar - Ignis
  [CLASSIC_SPELLS.STARLIGHT.id]: 0.5, // Ulduar - Hodir
  //endregion

  //region Encounter
  //Raids
  [SPELLS.ASTRAL_FLARE_BUFF.id]: { hastePerStack: 0.05 }, // Sarkareth
  //endregion
};

class Haste extends Analyzer {
  static dependencies = {
    eventEmitter: EventEmitter,
    statTracker: StatTracker,
  };

  protected statTracker!: StatTracker;
  protected eventEmitter!: EventEmitter;

  protected hasteBuffs: HasteBuffMap = {
    ...HASTE_BUFFS,
  };

  get changehaste() {
    return new EventFilter(EventType.ChangeHaste);
  }

  current: number;

  constructor(options: Options) {
    super(options);
    this.current = (options.statTracker as StatTracker).currentHastePercentage;
    debug && console.log(`Haste: Starting haste: ${formatPercentage(this.current)}%`);
    this.eventEmitter = options.eventEmitter as EventEmitter;
    this._triggerChangeHaste(null, null, this.current);
    this.addEventListener(Events.applybuff.to(SELECTED_PLAYER), this.onApplyBuff);
    this.addEventListener(Events.changebuffstack.to(SELECTED_PLAYER), this.onChangeBuffStack);
    this.addEventListener(Events.removebuff.to(SELECTED_PLAYER), this.onRemoveBuff);
    this.addEventListener(Events.applydebuff.to(SELECTED_PLAYER), this.onApplyDebuff);
    this.addEventListener(Events.changedebuffstack.to(SELECTED_PLAYER), this.onChangeDebuffStack);
    this.addEventListener(Events.removedebuff.to(SELECTED_PLAYER), this.onRemoveDebuff);
    this.addEventListener(Events.ChangeStats.to(SELECTED_PLAYER), this.onChangeStats);
  }

  /**
   * Adds a buff that affects the haste percentage.
   *
   * > HASTE RATING BUFFS ARE HANDLED BY THE STATTRACKER MODULE
   */
  addHasteBuff(
    spellId: number,
    /** Either a haste rating percentage (10% = 0.1), or a {@link HasteBuff} object. */
    haste: number | HasteBuff,
  ): void {
    this.hasteBuffs[spellId] = haste;
  }

  onApplyBuff(event: ApplyBuffEvent) {
    this._applyActiveBuff(event);
  }

  onChangeBuffStack(event: ChangeBuffStackEvent) {
    this._changeBuffStack(event);
  }

  onRemoveBuff(event: RemoveBuffEvent) {
    this._removeActiveBuff(event);
  }

  onApplyDebuff(event: ApplyDebuffEvent) {
    this._applyActiveBuff(event);
  }

  onChangeDebuffStack(event: ChangeDebuffStackEvent) {
    this._changeBuffStack(event);
  }

  onRemoveDebuff(event: RemoveDebuffEvent) {
    this._removeActiveBuff(event);
  }

  onChangeStats(event: ChangeStatsEvent) {
    // fabbed event from StatTracker
    if (!event.delta.haste) {
      return;
    }

    // Calculating the Haste percentage difference form a rating change is hard because all rating (from gear + buffs) is additive while Haste percentage buffs are both multiplicative and additive (see the applyHaste function).
    // 1. Calculate the total Haste percentage without any rating (since the total percentage from the total rating multiplies like any other Haste buff)
    const remainingHasteBuffs = Haste.removeHaste(
      this.current,
      this.statTracker.hastePercentage(event.before.haste, true),
    );
    // 2. Calculate the new total Haste percentage with the new rating and the old total buff percentage
    const newHastePercentage = Haste.addHaste(
      this.statTracker.hastePercentage(event.after.haste, true),
      remainingHasteBuffs,
    );

    this._setHaste(event, newHastePercentage);

    if (debug && 'ability' in event.trigger) {
      const spellName = event.trigger.ability ? event.trigger.ability.name : 'unknown';
      console.log(
        formatMilliseconds(this.owner.fightDuration),
        `Haste: Current haste: ${formatPercentage(this.current!)}% (haste RATING changed by ${
          event.delta.haste
        } from ${spellName})`,
      );
    }
  }

  _applyActiveBuff(event: ApplyBuffEvent | ApplyDebuffEvent) {
    const spellId = event.ability.guid;
    const hasteGain = this._getBaseHasteGain(spellId);

    if (hasteGain) {
      this._applyHasteGain(event, hasteGain);

      debug &&
        console.log(
          formatMilliseconds(this.owner.fightDuration),
          'Haste:',
          'Current haste:',
          `${formatPercentage(this.current!)}%`,
          `(gained ${formatPercentage(hasteGain)}% from ${event.ability.name})`,
        );
    } else {
      debug &&
        console.warn(
          formatMilliseconds(this.owner.fightDuration),
          'Haste: Applied not recognized buff:',
          event.ability.name,
        );
    }
  }

  _removeActiveBuff(event: RemoveBuffEvent | RemoveDebuffEvent) {
    const spellId = event.ability.guid;
    const haste = this._getBaseHasteGain(spellId);

    if (haste) {
      this._applyHasteLoss(event, haste);

      debug &&
        console.log(
          formatMilliseconds(this.owner.fightDuration),
          `Haste: Current haste: ${formatPercentage(this.current!)}% (lost ${formatPercentage(
            haste,
          )}% from ${SPELLS[spellId] ? SPELLS[spellId].name : spellId})`,
        );
    } else {
      debug &&
        console.warn(
          formatMilliseconds(this.owner.fightDuration),
          'Haste: Removed not recognized buff:',
          event.ability.name,
        );
    }
  }

  /**
   * Gets the base Haste gain for the provided spell.
   */
  _getBaseHasteGain(spellId: number) {
    const hasteBuff = this.hasteBuffs[spellId] || undefined;

    if (typeof hasteBuff === 'number') {
      // A regular number is a static Haste percentage
      return hasteBuff;
    } else if (typeof hasteBuff === 'object') {
      // An object can provide more info
      if (hasteBuff.haste) {
        return this._getHasteValue(hasteBuff.haste, hasteBuff);
      }
    }
    return null;
  }

  _changeBuffStack(event: ChangeBuffStackEvent | ChangeDebuffStackEvent) {
    const spellId = event.ability.guid;
    const haste = this._getHastePerStackGain(spellId);

    if (haste) {
      // Haste stacks are additive, so at 5 stacks with 3% per you'd be at 15%, 6 stacks = 18%. This means the only right way to add a Haste stack is to reset to Haste without the old total and then add the new total Haste again.
      // 1. Calculate the total Haste percentage without the buff
      const baseHaste = Haste.removeHaste(this.current, event.oldStacks * haste);
      // 2. Calculate the new total Haste percentage with the Haste from the new amount of stacks
      const newHastePercentage = Haste.addHaste(baseHaste, event.newStacks * haste);

      this._setHaste(event, newHastePercentage);

      debug &&
        console.log(
          formatMilliseconds(this.owner.fightDuration),
          `Haste: Current haste: ${formatPercentage(this.current!)}% (gained ${formatPercentage(
            haste * event.stacksGained,
          )}% from ${SPELLS[spellId] ? SPELLS[spellId].name : spellId})`,
        );
    }
  }

  _getHastePerStackGain(spellId: number) {
    const hasteBuff = this.hasteBuffs[spellId] || undefined;

    if (typeof hasteBuff === 'number') {
      // hasteBuff being a number is shorthand for static haste only
    } else if (typeof hasteBuff === 'object') {
      if (hasteBuff.hastePerStack) {
        return this._getHasteValue(hasteBuff.hastePerStack, hasteBuff);
      }
    }
    return null;
  }

  /**
   * Get the actual Haste value from a prop allowing various formats.
   */
  _getHasteValue(
    value: number | ((combatant: Combatant, item?: Item) => number),
    hasteBuff: HasteBuff | number,
  ) {
    if (typeof value === 'function') {
      const selectedCombatant = this.selectedCombatant;
      let itemDetails;
      if (typeof hasteBuff === 'object' && hasteBuff.itemId) {
        const { itemId } = hasteBuff;
        itemDetails = selectedCombatant.getItem(itemId);
        if (!itemDetails) {
          console.error('Failed to retrieve item information for item with ID:', itemId);
        }
      }
      return value(selectedCombatant, itemDetails);
    }
    return value;
  }

  _applyHasteGain(event: AnyEvent, haste: number) {
    this._setHaste(event, Haste.addHaste(this.current, haste));
  }

  _applyHasteLoss(event: AnyEvent, haste: number) {
    this._setHaste(event, Haste.removeHaste(this.current, haste));
  }

  _setHaste(event: AnyEvent, haste: number) {
    if (isNaN(haste)) {
      throw new Error('Attempted to set an invalid Haste value. Something broke.');
    }
    const oldHaste = this.current;
    this.current = haste;

    this._triggerChangeHaste(event, oldHaste, this.current);
  }

  _triggerChangeHaste(event: AnyEvent | null, oldHaste: number | null, newHaste: number) {
    const fabricatedEvent = {
      type: EventType.ChangeHaste,
      sourceID: event ? (event as SourcedEvent<any>).sourceID : this.owner.playerId,
      targetID: this.owner.playerId,
      oldHaste,
      newHaste,
    };
    debug && console.log(EventType.ChangeHaste, fabricatedEvent);
    this.eventEmitter.fabricateEvent(fabricatedEvent, event);
  }

  static addHaste(baseHaste: number, hasteGain: number) {
    return baseHaste * (1 + hasteGain) + hasteGain;
  }

  static removeHaste(baseHaste: number, hasteLoss: number) {
    return (baseHaste - hasteLoss) / (1 + hasteLoss);
  }
}

export default Haste;
