import {Hotspot} from './Hotspot';

export class Pages {

    static createPages(pictures, callback) {
        let pages = [];
        for (let index = 0; index < pictures.length; index++) {
            pages.push(Pages.createPage(pictures[index], index, callback));
        }
        return pages;
    }

    static createPage(src, index, callback) {
        let pageContainer = Pages.createPageContainer(src, index);
        pageContainer.addChild(new createjs.Bitmap(src));

        for (let xyz = 0; xyz <= 50; xyz++) {
            Pages.createHotSpot(pageContainer, callback);
        }

        return pageContainer;
    }

    static createHotSpot(container, callback) {
        let picture = new Image();
        let index = Math.floor(Math.random() * 3) + 1;
        picture.src = "img/hotspot_" + index + ".jpeg";
        picture.onload = () => {
            let hotspot = new Hotspot(picture);
            container.addChild(hotspot);
            Hotspot.setRandomPosition(hotspot);
            callback();
        };
    }

    static createPageContainer(picture, index) {
        let pageContainer = new createjs.Container();
        let innerWidth = window.innerWidth * window.devicePixelRatio / 2; // double page
        let ratio = Math.min(innerWidth / picture.width, window.innerHeight * window.devicePixelRatio / picture.height);
        let rectWidth = ratio * picture.width;

        pageContainer.scaleX = pageContainer.scaleY = window.innerHeight * window.devicePixelRatio / picture.height;
        pageContainer.x = (rectWidth + 10) * index;
        pageContainer.y = 0;

        return pageContainer;
    }

}


