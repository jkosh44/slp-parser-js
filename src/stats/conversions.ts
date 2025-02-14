import _ from 'lodash';
import { SlippiGame } from "../SlippiGame";
import { PostFrameUpdateType } from "../utils/slpReader";
import { MoveLandedType, ConversionType } from "./common";
import {
  iterateFramesInOrder, isDamaged, isGrabbed, calcDamageTaken, isInControl, didLoseStock,
  Timers
} from "./common";

export function generateConversions(game: SlippiGame): ConversionType[] {
  const conversions: ConversionType[] = [];
  const frames = game.getFrames();

  const initialState: {
    conversion: ConversionType | null;
    move: MoveLandedType | null;
    resetCounter: number;
    lastHitAnimation: number | null;
  } = {
    conversion: null,
    move: null,
    resetCounter: 0,
    lastHitAnimation: null,
  };

  // Only really doing assignment here for flow
  let state = initialState;

  // Iterates the frames in order in order to compute conversions
  iterateFramesInOrder(game, () => {
    state = { ...initialState };
  }, (indices, frame) => {
    const playerFrame: PostFrameUpdateType = frame.players[indices.playerIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevPlayerFrame: any = _.get(
      frames, [playerFrame.frame - 1, 'players', indices.playerIndex, 'post'], {}
    );
    const opponentFrame: PostFrameUpdateType = frame.players[indices.opponentIndex].post;
    // FIXME: use type PostFrameUpdateType instead of any
    // This is because the default value {} should not be casted as a type of PostFrameUpdateType
    const prevOpponentFrame: any = _.get(
      frames, [playerFrame.frame - 1, 'players', indices.opponentIndex, 'post'], {}
    );

    const opntIsDamaged = isDamaged(opponentFrame.actionStateId);
    const opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
    const opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);

    // Keep track of whether actionState changes after a hit. Used to compute move count
    // When purely using action state there was a bug where if you did two of the same
    // move really fast (such as ganon's jab), it would count as one move. Added
    // the actionStateCounter at this point which counts the number of frames since
    // an animation started. Should be more robust, for old files it should always be
    // null and null < null = false
    const actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
    const actionCounter = playerFrame.actionStateCounter;
    const prevActionCounter = prevPlayerFrame.actionStateCounter;
    const actionFrameCounterReset = actionCounter < prevActionCounter;
    if (actionChangedSinceHit || actionFrameCounterReset) {
      state.lastHitAnimation = null;
    }

    // If opponent took damage and was put in some kind of stun this frame, either
    // start a conversion or
    if (opntIsDamaged || opntIsGrabbed) {
      if (!state.conversion) {
        state.conversion = {
          playerIndex: indices.playerIndex,
          opponentIndex: indices.opponentIndex,
          startFrame: playerFrame.frame,
          endFrame: null,
          startPercent: prevOpponentFrame.percent || 0,
          currentPercent: opponentFrame.percent || 0,
          endPercent: null,
          moves: [],
          didKill: false,
          openingType: "unknown", // Will be updated later
        };

        conversions.push(state.conversion);
      }

      if (opntDamageTaken) {
        // If animation of last hit has been cleared that means this is a new move. This
        // prevents counting multiple hits from the same move such as fox's drill
        if (!state.lastHitAnimation) {
          state.move = {
            frame: playerFrame.frame,
            moveId: playerFrame.lastAttackLanded,
            hitCount: 0,
            damage: 0,
          };

          state.conversion.moves.push(state.move);
        }

        if (state.move) {
          state.move.hitCount += 1;
          state.move.damage += opntDamageTaken;
        }

        // Store previous frame animation to consider the case of a trade, the previous
        // frame should always be the move that actually connected... I hope
        state.lastHitAnimation = prevPlayerFrame.actionStateId;
      }
    }

    if (!state.conversion) {
      // The rest of the function handles conversion termination logic, so if we don't
      // have a conversion started, there is no need to continue
      return;
    }

    const opntInControl = isInControl(opponentFrame.actionStateId);
    const opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);

    // Update percent if opponent didn't lose stock
    if (!opntDidLoseStock) {
      state.conversion.currentPercent = opponentFrame.percent || 0;
    }

    if (opntIsDamaged || opntIsGrabbed) {
      // If opponent got grabbed or damaged, reset the reset counter
      state.resetCounter = 0;
    }

    const shouldStartResetCounter = state.resetCounter === 0 && opntInControl;
    const shouldContinueResetCounter = state.resetCounter > 0;
    if (shouldStartResetCounter || shouldContinueResetCounter) {
      // This will increment the reset timer under the following conditions:
      // 1) if we were punishing opponent but they have now entered an actionable state
      // 2) if counter has already started counting meaning opponent has entered actionable state
      state.resetCounter += 1;
    }

    let shouldTerminate = false;

    // Termination condition 1 - player kills opponent
    if (opntDidLoseStock) {
      state.conversion.didKill = true;
      shouldTerminate = true;
    }

    // Termination condition 2 - conversion resets on time
    if (state.resetCounter > Timers.PUNISH_RESET_FRAMES) {
      shouldTerminate = true;
    }

    // If conversion should terminate, mark the end states and add it to list
    if (shouldTerminate) {
      state.conversion.endFrame = playerFrame.frame;
      state.conversion.endPercent = prevOpponentFrame.percent || 0;

      state.conversion = null;
      state.move = null;
    }
  });

  // Adds opening type to the punishes
  addOpeningTypeToConversions(game, conversions);

  return conversions;
}

function addOpeningTypeToConversions(game: SlippiGame, conversions: Array<ConversionType>): void {
  const conversionsByPlayerIndex = _.groupBy(conversions, 'playerIndex');
  const keyedConversions = _.mapValues(conversionsByPlayerIndex, (playerConversions) => (
    _.keyBy(playerConversions, 'startFrame')
  ));

  const initialState: {
    opponentConversion: ConversionType | null;
  } = {
    opponentConversion: null
  };

  // Only really doing assignment here for flow
  let state = initialState;

  // console.log(punishesByPlayerIndex);

  // Iterates the frames in order in order to compute punishes
  iterateFramesInOrder(game, () => {
    state = { ...initialState };
  }, (indices, frame) => {
    const frameNum = frame.frame;

    // Clear opponent conversion if it ended this frame
    if (_.get(state, ['opponentConversion', 'endFrame']) === frameNum) {
      state.opponentConversion = null;
    }

    // Get opponent conversion. Add to state if exists for this frame
    const opponentConversion = _.get(keyedConversions, [indices.opponentIndex, frameNum]);
    if (opponentConversion) {
      state.opponentConversion = opponentConversion;
    }

    const playerConversion = _.get(keyedConversions, [indices.playerIndex, frameNum]);
    if (!playerConversion) {
      // Only need to do something if a conversion for this player started on this frame
      return;
    }

    // In the case where punishes from both players start on the same frame, set trade
    if (playerConversion && opponentConversion) {
      playerConversion.openingType = "trade";
      return;
    }

    // TODO: Handle this in a better way. It probably shouldn't be considered a neutral
    // TODO: win in the case where a player attacks into a crouch cancel and gets
    // TODO: countered on.
    // TODO: Also perhaps if a player gets a random hit in the middle of a the other
    // TODO: player's combo it shouldn't be called a counter-attack

    // If opponent has an active conversion, this is a counter-attack, otherwise a neutral win
    playerConversion.openingType = state.opponentConversion ? "counter-attack" : "neutral-win";
  });
}
