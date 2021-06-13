import { AttributesMessage, patchStyle, safeParseJson, StyleInfo } from '@lunasec/browser-common';
import { ClassLookup, TagLookup } from '@lunasec/react-sdk';

import { initializeUploader } from './initialize-uploader';
import { detokenize, listenForRPCMessages, sendMessageToParentFrame } from './rpc';
import { handleDownload } from './secure-download';
export type SupportedElement = TagLookup[keyof TagLookup];

export function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Would be nice if class could take <element type parameter> but couldn't quite get it working
export class SecureFrame<e extends keyof ClassLookup> {
  private readonly componentName: e;
  private readonly loadingText: Element;
  private initialized = false;
  readonly frameNonce: string;
  readonly origin: string;
  readonly secureElement: HTMLElementTagNameMap[TagLookup[e]];
  private token?: string;

  constructor(componentName: e, loadingText: Element) {
    this.componentName = componentName;
    this.loadingText = loadingText;
    this.secureElement = this.insertSecureElement(componentName);
    this.origin = this.getURLSearchParam('origin');
    this.frameNonce = this.getURLSearchParam('n');
    listenForRPCMessages(this.origin, (attrs) => {
      void this.setAttributesFromRPC(attrs);
    });
    sendMessageToParentFrame(this.origin, {
      command: 'NotifyOnStart',
      data: {},
      frameNonce: this.frameNonce,
    });
  }

  insertSecureElement(elementName: e) {
    const body = document.getElementsByTagName('BODY')[0];
    const secureElement = document.createElement(elementName) as HTMLElementTagNameMap[TagLookup[e]];
    secureElement.className = 'secure-input d-none';
    body.appendChild(secureElement);
    return secureElement;
  }

  getURLSearchParam(paramName: string) {
    const searchParams = new URL(document.location.href).searchParams;
    const param = searchParams.get(paramName);
    if (!param) {
      throw new Error(`Missing parameter from iframe url ${paramName}`);
    }
    return param;
  }

  // Set up the iframe attributes, used on both page load and on any subsequent changes
  async setAttributesFromRPC(attrs: AttributesMessage) {
    if (attrs.component !== this.componentName) {
      throw new Error('Received an attribute message different than what the iframe was initialized with');
    }
    // First time setup
    if (!this.initialized) {
      this.loadingText.classList.add('d-none');
      this.secureElement.classList.remove('d-none');
      if (!attrs.style) {
        console.error('Attribute frame message missing necessary style parameter for first time frame startup', attrs);
        return;
      }

      if (attrs.component === 'Uploader') {
        initializeUploader(this, attrs.fileTokens || []);
      }
    }

    if (attrs.style) {
      patchStyle(this.secureElement, safeParseJson<StyleInfo>(attrs.style));
    }

    if (attrs.type && attrs.component === 'Input') {
      this.secureElement.setAttribute('type', attrs.type);
    }

    if (attrs.token && attrs.token !== this.token) {
      this.token = attrs.token;
      await this.handleToken(attrs.token, attrs);
    }

    if (this.componentName === 'Input') {
      this.attachOnBlurNotifier();
    }

    if (!this.initialized) {
      sendMessageToParentFrame(this.origin, {
        command: 'NotifyOnFullyLoaded',
        data: {},
        frameNonce: this.frameNonce,
      });
    }
    this.initialized = true;

    return;
  }

  // TODO: This is getting pretty branchy.  Considering a different architecture where each element type is a separate webpack entrypoint with shared logic from a /common.ts module
  async handleToken(token: string, attrs: AttributesMessage) {
    if (attrs.component === 'Downloader') {
      // anchor elements mean we are doing an s3 secure download
      // Figure out why this type casting is necessary
      try {
        await handleDownload(token, this.secureElement as HTMLAnchorElement, attrs.hidden || false);
      } catch (e) {
        // TODO: Make this less ugly (it's blue atm and garbage lol)
        this.secureElement.textContent = 'Error: Missing File';
      }
    } else {
      const value = await detokenize(token);
      if (attrs.component === 'Input') {
        const input = this.secureElement as HTMLInputElement;
        input.value = value;
      }
      if (attrs.component === 'Paragraph') {
        this.secureElement.textContent = value;
      }
    }
  }

  attachOnBlurNotifier() {
    this.secureElement.addEventListener('blur', () => {
      sendMessageToParentFrame(this.origin, { command: 'NotifyOnBlur', frameNonce: this.frameNonce, data: {} });
    });
  }
}
