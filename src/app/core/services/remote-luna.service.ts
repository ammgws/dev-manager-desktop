import {
  CommandData,
  CommandSubject,
  escapeSingleQuoteString,
  ExecutionError,
  RemoteCommandService
} from "./remote-command.service";
import {Injectable} from "@angular/core";
import {DeviceLike} from "../../types";
import {lastValueFrom, Observable, ReplaySubject, Subject, Subscription} from "rxjs";
import {filter, map} from "rxjs/operators";
import {omit} from "lodash";
import {isNonNull} from "../../shared/operators";

export declare interface LunaResponse extends Record<string, any> {
  returnValue?: boolean,
  subscribed?: boolean,
}

@Injectable({
  providedIn: 'root'
})
export class RemoteLunaService {
  constructor(private commands: RemoteCommandService) {
  }

  async call<T extends LunaResponse>(device: DeviceLike, uri: string, param: Record<string, unknown> = {}, pub: boolean = true): Promise<T> {
    const sendCmd = pub ? 'luna-send-pub' : 'luna-send';
    return this.commands.exec(device, `${sendCmd} -n 1 ${uri} ${escapeSingleQuoteString(JSON.stringify(param))}`, 'utf-8')
      .catch(e => {
        if (ExecutionError.isCompatible(e) && e.status == 127) {
          throw new LunaUnsupportedError(`Failed to find command ${sendCmd}. Is this really a webOS device?`);
        }
        throw e;
      })
      .then(out => {
        let typed: T;
        try {
          typed = JSON.parse(out.trim());
        } catch (e) {
          console.warn('Invalid luna call response: ', out);
          throw new Error(`Bad response ${out}`);
        }
        if (!typed.returnValue) {
          throw new LunaResponseError(typed);
        }
        return typed;
      });
  }

  async subscribe<T extends LunaResponse>(device: DeviceLike, uri: string, param: Record<string, unknown> = {},
                                          pub: boolean = true): Promise<LunaSubscription<T>> {
    const sendCmd = pub ? 'luna-send-pub' : 'luna-send';
    const command = `${sendCmd} -i ${uri} ${escapeSingleQuoteString(JSON.stringify(param))}`;
    try {
      const subject = await this.commands.popen(device, command, 'utf-8');
      return new LunaSubscription<T>(subject);
    } catch (e) {
      if (ExecutionError.isCompatible(e) && e.status == 127) {
        throw new LunaUnsupportedError(`Failed to find command ${sendCmd}. Is this really a webOS device?`);
      }
      throw e;
    }
  }
}

export class LunaSubscription<T> {
  private subject: Subject<T>;
  private subscription?: Subscription;
  private stderr = '';

  constructor(private proc: CommandSubject<string>) {
    this.subject = new ReplaySubject<T>();
    this.subscription = proc.pipe(map((v: CommandData<string>) => {
      if (v.fd === 0) {
        return JSON.parse(v.data.trim());
      } else {
        this.stderr += v.data;
        return null;
      }
    }), filter(isNonNull)).subscribe({
      next: (value: T) => {
        console.log('luna command value', value);
        this.subject.next(value);
      },
      error: (err) => {
        console.log('luna command err', err);
        if (ExecutionError.isCompatible(err) && err.status == 127) {
          this.subject.error(new LunaUnsupportedError(`Failed to invoke luna-send command. Is this really a webOS device?`));
        } else {
          this.subject.error(err);
        }
      },
      complete: () => {
        console.log('luna command complete');
        this.subject.complete();
      },
    });
  }

  asObservable(): Observable<T> {
    return this.subject.asObservable();
  }

  /**
   * Multiple unsubscribe calls will not have side effect
   */
  async unsubscribe(): Promise<void> {
    const subscription = this.subscription;
    if (!subscription) {
      return;
    }
    this.subscription = undefined;
    await this.proc.write();
    await lastValueFrom(this.proc);
    subscription.unsubscribe();
  }
}

export class LunaUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class LunaResponseError extends Error {
  declare returnValue: false;
  details: string;

  [values: string]: any;

  constructor(payload: Record<string, any>) {
    super(`Luna call returned negative response: ${payload['errorText']}`);
    this.details = payload['errorText'];
    Object.assign(this, omit(payload, 'message', 'reason', 'details'))
  }

  static isCompatible(e: any): e is LunaResponseError {
    return typeof (e.message) === 'string' && e.returnValue === false;
  }

}
